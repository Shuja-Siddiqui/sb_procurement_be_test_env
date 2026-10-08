const crypto = require("crypto");
const prisma = require("../lib/prisma");
const Response = require("./Response");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Role } = require("@prisma/client");
const { safeGet, safeSet, safeDel } = require("../lib/redis");
const { sendPasswordResetOtpEmail } = require("../lib/mail");

const RESET_OTP_TTL_SECONDS = 10 * 60;
const RESET_TOKEN_TTL = "15m";
const RESET_MAX_ATTEMPTS = 5;
const memoryResetStore = new Map();

const otpKey = (userId) => `pwd-reset:otp:${userId}`;
const attemptsKey = (userId) => `pwd-reset:attempts:${userId}`;

const hashOtp = (code) =>
  crypto.createHash("sha256").update(String(code)).digest("hex");

const maskEmail = (email) => {
  const value = String(email || "").trim().toLowerCase();
  const at = value.indexOf("@");
  if (at <= 0) return "****";
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const visible =
    local.length <= 2 ? `${local[0] || "*"}*` : `${local.slice(0, 2)}***`;
  return `${visible}@${domain}`;
};

const isDeliverableEmail = (email) => {
  const value = String(email || "").trim().toLowerCase();
  if (!value || !value.includes("@")) return false;
  if (value.endsWith("@sbprocurement.local")) return false;
  return true;
};

const storeResetPayload = async (key, value, ttlSeconds) => {
  const saved = await safeSet(key, value, ttlSeconds);
  if (!saved) {
    memoryResetStore.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }
};

const readResetPayload = async (key) => {
  const fromRedis = await safeGet(key);
  if (fromRedis != null) return fromRedis;

  const local = memoryResetStore.get(key);
  if (!local) return null;
  if (Date.now() > local.expiresAt) {
    memoryResetStore.delete(key);
    return null;
  }
  return local.value;
};

const clearResetPayload = async (key) => {
  await safeDel(key);
  memoryResetStore.delete(key);
};

const toRoleEnum = (role) => {
  if (!role) return undefined;
  if (String(role).toLowerCase() === "site supervisor") return Role.SUPERVISOR;
  if (String(role).toLowerCase() === "super admin") return Role.SUPER_ADMIN;
  if (String(role).toLowerCase() === "sr. engineer") return Role.SR_ENGINEER;
  if (String(role).toLowerCase() === "sr engineer") return Role.SR_ENGINEER;
  const key = String(role).toUpperCase().replace(/\s+/g, "_");
  return Role[key] || undefined;
};

class Users extends Response {
  buildInternalEmail = ({ name, number }) => {
    const safeNumber = String(number || "")
      .replace(/\D/g, "")
      .slice(-12);
    const safeName = String(name || "user")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ".")
      .replace(/^\.+|\.+$/g, "")
      .slice(0, 24);
    const uniqueSuffix = Date.now();
    return `${safeName || "user"}.${
      safeNumber || uniqueSuffix
    }.internal@sbprocurement.local`;
  };

  normalizeProductIds = (productIds = []) =>
    (Array.isArray(productIds) ? productIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));

  checkUserDuplicates = async ({
    name,
    email,
    number,
    cnic,
    excludeUserId = null,
  }) => {
    const trimmedName = String(name || "").trim();
    const trimmedEmail = String(email || "").trim().toLowerCase();
    const trimmedNumber = String(number || "").trim();
    const trimmedCnic = String(cnic || "").trim();
    const exclude =
      excludeUserId && Number.isFinite(Number(excludeUserId))
        ? { id: { not: Number(excludeUserId) } }
        : {};
    const conflicts = [];

    if (trimmedName) {
      const existingByName = await prisma.user.findFirst({
        where: {
          ...exclude,
          name: { equals: trimmedName, mode: "insensitive" },
        },
        select: { id: true },
      });
      if (existingByName) conflicts.push("name");
    }

    if (trimmedEmail) {
      const existingByEmail = await prisma.user.findFirst({
        where: {
          ...exclude,
          email: { equals: trimmedEmail, mode: "insensitive" },
        },
        select: { id: true },
      });
      if (existingByEmail) conflicts.push("email");
    }

    if (trimmedNumber) {
      const existingByNumber = await prisma.user.findFirst({
        where: { ...exclude, number: trimmedNumber },
        select: { id: true },
      });
      if (existingByNumber) conflicts.push("phone number");
    }

    if (trimmedCnic) {
      const existingByCnic = await prisma.user.findFirst({
        where: { ...exclude, cnic: trimmedCnic },
        select: { id: true },
      });
      if (existingByCnic) conflicts.push("CNIC");
    }

    return conflicts;
  };

  hasUserManagementAccess = (req) => {
    const role = String(req?.user?.role || "").toUpperCase();
    return (
      role === Role.SUPER_ADMIN ||
      role === Role.DIRECTOR ||
      role === Role.ADMIN
    );
  };

  // Create user
  createUser = async (req, res) => {
    try {
      if (!this.hasUserManagementAccess(req)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Only Super Admin, Director, or Admin can manage users",
        });
      }
      const { name, email, password, role, cnic, gender, number, status, alreadyAssigned, isEdit } = req.body;
      const trimmedEmail = String(email || "").trim().toLowerCase();

      if (!trimmedEmail) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Email is required",
        });
      }

      const duplicateFields = await this.checkUserDuplicates({
        name,
        email: trimmedEmail,
        number,
        cnic,
      });
      if (duplicateFields.length > 0) {
        return this.sendResponse(req, res, {
          status: 409,
          message: `A user with this ${duplicateFields.join(", ")} already exists`,
        });
      }

      const roleEnum = toRoleEnum(role) || Role.SUPERVISOR;
      const productIds = this.normalizeProductIds(req.body.productIds);
      const purchaserAllProducts = Boolean(req.body.purchaserAllProducts);
      const saltRounds = 10;
      const salt = await bcrypt.genSalt(saltRounds);
      const hashedPassword = await bcrypt.hash(password, salt);
      const user = await prisma.user.create({
        data: {
          name,
          email: trimmedEmail,
          password: hashedPassword,
          role: roleEnum,
          purchaserAllProducts: roleEnum === Role.PURCHASER ? purchaserAllProducts : false,
          cnic,
          gender,
          number,
          status,
          ...(roleEnum === Role.PURCHASER
            ? {
                purchaserProducts: {
                  create: purchaserAllProducts
                    ? []
                    : productIds.map((productId) => ({ productId })),
                },
              }
            : {}),
          ...(alreadyAssigned !== undefined ? { alreadyAssigned } : {}),
          ...(isEdit !== undefined ? { isEdit } : {}),
        },
        include: {
          purchaserProducts: { select: { productId: true } },
        },
      });
      return this.sendResponse(req, res, {
        status: 201,
        message: "User created successfully",
        data: {
          ...user,
          productIds: user.purchaserProducts?.map((p) => p.productId) || [],
        },
      });
    } catch (error) {
      console.error(error);
      return this.sendResponse(req, res, {
        status: 400,
        message: "User creation failed",
        error: error.message,
      });
    }
  };

  // Get all users
  getUsers = async (req, res) => {
    try {
      if (!this.hasUserManagementAccess(req)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Only Super Admin, Director, or Admin can view users",
        });
      }
      const users = await prisma.user.findMany({
        include: {
          purchaserProducts: { select: { productId: true } },
          _count: {
            select: {
              updatedSites: true,
              siteSupervisors: true,
              sitePurchasers: true,
              siteSeniorEngineers: true,
            },
          },
        },
      });
      const totalSites = await prisma.site.count();
      return this.sendResponse(req, res, {
        status: 200,
        data: users.map((u) => ({
          ...u,
          productIds: u.purchaserProducts?.map((p) => p.productId) || [],
          assignedSiteCount:
            [Role.SUPER_ADMIN, Role.ADMIN, Role.DIRECTOR, Role.QA, Role.ACCOUNT].includes(u.role)
              ? totalSites
              : Number(u?._count?.updatedSites || 0) +
                Number(u?._count?.siteSupervisors || 0) +
                Number(u?._count?.sitePurchasers || 0) +
                Number(u?._count?.siteSeniorEngineers || 0),
        })),
      });
    } catch (error) {
      console.error(error);
      return this.sendResponse(req, res, {
        status: 500,
        message: "Could not retrieve users",
        error: error.message,
      });
    }
  };

  // Get single user by ID
  getUserById = async (req, res) => {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({
        where: { id: parseInt(id) },
        include: {
          purchaserProducts: { select: { productId: true } },
        },
      });

      if (!user) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "User not found",
        });
      }

      return this.sendResponse(req, res, {
        status: 200,
        data: {
          ...user,
          productIds: user.purchaserProducts?.map((p) => p.productId) || [],
        },
      });
    } catch (error) {
      console.error(error);
      return this.sendResponse(req, res, {
        status: 500,
        message: "Error retrieving user",
        error: error.message,
      });
    }
  };

  // Update user
  updateUser = async (req, res) => {
    try {
      if (!this.hasUserManagementAccess(req)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Only Super Admin, Admin, or Director can manage users",
        });
      }
      const { id } = req.params;
      const { name, email, password, role, cnic, gender, number, status, alreadyAssigned, isEdit } = req.body;
      const trimmedEmail =
        email !== undefined ? String(email || "").trim().toLowerCase() : undefined;

      if (email !== undefined && !trimmedEmail) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Email is required",
        });
      }

      const duplicateFields = await this.checkUserDuplicates({
        name,
        email: trimmedEmail,
        number,
        cnic,
        excludeUserId: parseInt(id),
      });
      if (duplicateFields.length > 0) {
        return this.sendResponse(req, res, {
          status: 409,
          message: `A user with this ${duplicateFields.join(", ")} already exists`,
        });
      }

      const nextRole = role ? toRoleEnum(role) : undefined;
      const productIds = this.normalizeProductIds(req.body.productIds);
      const purchaserAllProducts =
        req.body.purchaserAllProducts !== undefined
          ? Boolean(req.body.purchaserAllProducts)
          : undefined;
      const data = {
        ...(name !== undefined ? { name } : {}),
        ...(trimmedEmail !== undefined ? { email: trimmedEmail } : {}),
        ...(cnic !== undefined ? { cnic } : {}),
        ...(gender !== undefined ? { gender } : {}),
        ...(number !== undefined ? { number } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(alreadyAssigned !== undefined ? { alreadyAssigned } : {}),
        ...(isEdit !== undefined ? { isEdit } : {}),
        ...(role ? { role: toRoleEnum(role) } : {}),
        ...(purchaserAllProducts !== undefined
          ? { purchaserAllProducts }
          : {}),
      };
      if (password) {
        const salt = await bcrypt.genSalt(10);
        data.password = await bcrypt.hash(password, salt);
      }
      const currentUser = await prisma.user.findUnique({
        where: { id: parseInt(id) },
        select: { role: true },
      });
      const effectiveRole = nextRole || currentUser?.role;
      const updatedUser = await prisma.user.update({
        where: { id: parseInt(id) },
        data: {
          ...data,
          purchaserProducts:
            effectiveRole === Role.PURCHASER && !Boolean(purchaserAllProducts)
              ? {
                  deleteMany: {},
                  create: productIds.map((productId) => ({ productId })),
                }
              : effectiveRole === Role.PURCHASER && Boolean(purchaserAllProducts)
              ? { deleteMany: {} }
              : { deleteMany: {} },
        },
        include: {
          purchaserProducts: { select: { productId: true } },
        },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "User updated",
        data: {
          ...updatedUser,
          productIds: updatedUser.purchaserProducts?.map((p) => p.productId) || [],
        },
      });
    } catch (error) {
      console.error(error);
      return this.sendResponse(req, res, {
        status: 400,
        message: "Update failed",
        error: error.message,
      });
    }
  };

  // Delete user
  deleteUser = async (req, res) => {
    try {
      if (!this.hasUserManagementAccess(req)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Only Super Admin or Director can manage users",
        });
      }
      const { id } = req.params;
      const userId = Number(id);
      if (!Number.isFinite(userId) || userId <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Invalid user id",
        });
      }
      if (Number(req.user?.id) === userId) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "You cannot delete your own account",
        });
      }

      const existingUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!existingUser) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "User not found",
        });
      }

      await prisma.$transaction(async (tx) => {
        await tx.requestStage.deleteMany({ where: { userId } });
        await tx.siteSupervisor.deleteMany({ where: { userId } });
        await tx.sitePurchaser.deleteMany({ where: { userId } });
        await tx.siteSeniorEngineer.deleteMany({ where: { userId } });
        await tx.pushSubscription.deleteMany({ where: { userId } });
        await tx.chatMember.deleteMany({ where: { userId } });
        await tx.chatGroup.updateMany({
          where: { createdById: userId },
          data: { createdById: Number(req.user?.id) || userId },
        });
        await tx.user.delete({ where: { id: userId } });
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "User deleted",
      });
    } catch (error) {
      console.error(error);
      return this.sendResponse(req, res, {
        status: 400,
        message: "Deletion failed",
        error: error.message,
      });
    }
  };

  // Sign in
  signIn = async (req, res) => {
    try {
      const { identifier, password } = req.body;

      // Check if identifier and password are provided
      if (!identifier || !password) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Username/phone and password are required",
        });
      }

      const cleanIdentifier = String(identifier).trim();
      const user = await prisma.user.findFirst({
        where: {
          OR: [
            { number: cleanIdentifier },
            { name: { equals: cleanIdentifier, mode: "insensitive" } },
          ],
        },
        include: {
          purchaserProducts: { select: { productId: true } },
        },
      });

      if (!user) {
        return this.sendResponse(req, res, {
          status: 401,
          message: "Invalid username/phone or password",
        });
      }

      const userStatus = String(user.status || "").trim().toLowerCase();
      if (userStatus && userStatus !== "active") {
        return this.sendResponse(req, res, {
          status: 401,
          message: "User account is inactive",
        });
      }

      // Compare password
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return this.sendResponse(req, res, {
          status: 401,
          message: "Invalid username/phone or password",
        });
      }

      // Create token
      const token = jwt.sign(
        {
          id: user.id,
          role: user.role,
          name: user.name,
        },
        process.env.JWT_SECRET,
        { expiresIn: "30d" }
      );

      // Send respons
      return this.sendResponse(req, res, {
        status: 200,
        message: "Login successful",
        data: {
          token,
          user: {
            id: user.id,
            name: user.name,
            role: String(user.role).toLowerCase(),
            number: user?.number,
            phone: user?.number,
            cnic: user.cnic,
            purchaserAllProducts: user.purchaserAllProducts,
            productIds: user.purchaserProducts?.map((p) => p.productId) || [],
            ...(user.role === Role.DIRECTOR && { isEdit: user?.isEdit }),
          },
        },
      });
    } catch (error) {
      console.error("Login Error:", error);
      return this.sendResponse(req, res, {
        status: 500,
        message: "Internal server error",
      });
    }
  };
  changeOwnPassword = async (req, res) => {
    try {
      const userId = Number(req.user?.id);
      const { currentPassword, newPassword } = req.body;

      if (!Number.isFinite(userId) || userId <= 0) {
        return this.sendResponse(req, res, {
          status: 401,
          message: "Unauthorized",
        });
      }

      if (!currentPassword || !newPassword) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Current password and new password are required",
        });
      }

      if (String(newPassword).length < 6) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "New password must be at least 6 characters",
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "User not found",
        });
      }

      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch) {
        return this.sendResponse(req, res, {
          status: 401,
          message: "Current password is incorrect",
        });
      }

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(newPassword, salt);

      await prisma.user.update({
        where: { id: userId },
        data: { password: hashedPassword },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Password updated successfully",
      });
    } catch (error) {
      console.error(error);
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to update password",
        error: error.message,
      });
    }
  };

  findUserByIdentifier = async (identifier) => {
    const cleanIdentifier = String(identifier || "").trim();
    if (!cleanIdentifier) return null;

    return prisma.user.findFirst({
      where: {
        OR: [
          { number: cleanIdentifier },
          { name: { equals: cleanIdentifier, mode: "insensitive" } },
          { email: { equals: cleanIdentifier, mode: "insensitive" } },
        ],
      },
    });
  };

  // Step 1: request verification code for password reset (email OTP)
  forgotPassword = async (req, res) => {
    try {
      const { identifier } = req.body;
      if (!identifier || !String(identifier).trim()) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Username, phone, or email is required",
        });
      }

      const user = await this.findUserByIdentifier(identifier);
      if (!user) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "No account found with this username, phone, or email",
        });
      }

      const userStatus = String(user.status || "").trim().toLowerCase();
      if (userStatus && userStatus !== "active") {
        return this.sendResponse(req, res, {
          status: 401,
          message: "User account is inactive",
        });
      }

      if (!isDeliverableEmail(user.email)) {
        return this.sendResponse(req, res, {
          status: 400,
          message:
            "No valid email is linked to this account. Please contact your administrator.",
        });
      }

      const code = String(crypto.randomInt(100000, 1000000));
      await storeResetPayload(
        otpKey(user.id),
        { hash: hashOtp(code), userId: user.id },
        RESET_OTP_TTL_SECONDS
      );
      await clearResetPayload(attemptsKey(user.id));

      const expiresMinutes = Math.ceil(RESET_OTP_TTL_SECONDS / 60);
      const mailResult = await sendPasswordResetOtpEmail({
        to: user.email,
        name: user.name,
        code,
        expiresMinutes,
      });

      const isDev = String(process.env.NODE_ENV || "").toLowerCase() !== "production";
      const responseData = {
        maskedEmail: maskEmail(user.email),
        expiresInSeconds: RESET_OTP_TTL_SECONDS,
      };

      if (!mailResult.sent) {
        console.log(
          `[password-reset] SMTP not configured — OTP for user=${user.id} email=${user.email}: ${code}`
        );
        if (!isDev) {
          return this.sendResponse(req, res, {
            status: 503,
            message:
              "Email service is not configured. Please contact your administrator.",
          });
        }
        responseData.devVerificationCode = code;
      }

      return this.sendResponse(req, res, {
        status: 200,
        message: "Verification code sent to your email",
        data: responseData,
      });
    } catch (error) {
      console.error("Forgot password error:", error);
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to send verification code",
      });
    }
  };

  // Step 2: verify OTP and issue short-lived reset token
  verifyResetCode = async (req, res) => {
    try {
      const { identifier, code } = req.body;
      if (!identifier || !code) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Account identifier and verification code are required",
        });
      }

      const cleanCode = String(code).trim();
      if (!/^\d{6}$/.test(cleanCode)) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Verification code must be 6 digits",
        });
      }

      const user = await this.findUserByIdentifier(identifier);
      if (!user) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "No account found with this username, phone, or email",
        });
      }

      const attemptsRaw = await readResetPayload(attemptsKey(user.id));
      const attempts = Number(attemptsRaw) || 0;
      if (attempts >= RESET_MAX_ATTEMPTS) {
        await clearResetPayload(otpKey(user.id));
        return this.sendResponse(req, res, {
          status: 429,
          message: "Too many invalid attempts. Please request a new code.",
        });
      }

      const stored = await readResetPayload(otpKey(user.id));
      const storedHash =
        typeof stored === "object" && stored ? stored.hash : stored;

      if (!storedHash || storedHash !== hashOtp(cleanCode)) {
        await storeResetPayload(
          attemptsKey(user.id),
          attempts + 1,
          RESET_OTP_TTL_SECONDS
        );
        return this.sendResponse(req, res, {
          status: 400,
          message: "Invalid or expired verification code",
        });
      }

      await clearResetPayload(otpKey(user.id));
      await clearResetPayload(attemptsKey(user.id));

      const resetToken = jwt.sign(
        {
          id: user.id,
          purpose: "password-reset",
        },
        process.env.JWT_SECRET,
        { expiresIn: RESET_TOKEN_TTL }
      );

      return this.sendResponse(req, res, {
        status: 200,
        message: "Verification successful",
        data: { resetToken },
      });
    } catch (error) {
      console.error("Verify reset code error:", error);
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to verify code",
      });
    }
  };

  // Step 3: set a new password using reset token
  resetPassword = async (req, res) => {
    try {
      const { resetToken, newPassword } = req.body;

      if (!resetToken || !newPassword) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Reset token and new password are required",
        });
      }

      if (String(newPassword).length < 6) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "New password must be at least 6 characters",
        });
      }

      let decoded;
      try {
        decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
      } catch {
        return this.sendResponse(req, res, {
          status: 401,
          message: "Reset session expired. Please request a new code.",
        });
      }

      if (decoded?.purpose !== "password-reset" || !decoded?.id) {
        return this.sendResponse(req, res, {
          status: 401,
          message: "Invalid reset token",
        });
      }

      const userId = Number(decoded.id);
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "User not found",
        });
      }

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(String(newPassword), salt);

      await prisma.user.update({
        where: { id: userId },
        data: { password: hashedPassword },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Password reset successfully",
      });
    } catch (error) {
      console.error("Reset password error:", error);
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to reset password",
      });
    }
  };

  // Update isEdit field only
  updateUserEditStatus = async (req, res) => {
    try {
      if (!this.hasUserManagementAccess(req)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Only Super Admin or Director can update edit status",
        });
      }
      const { id } = req.params; // user ID from URL
      const { isEdit } = req.body; // true or false

      if (typeof isEdit !== "boolean") {
        return this.sendResponse(req, res, {
          status: 400,
          message: "isEdit must be true or false",
        });
      }

      const updatedUser = await prisma.user.update({
        where: { id: parseInt(id) },
        data: { isEdit },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "User edit status updated",
        data: {
          id: updatedUser.id,
          isEdit: updatedUser.isEdit,
        },
      });
    } catch (error) {
      console.error(error);
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to update edit status",
        error: error.message,
      });
    }
  };
}

module.exports = Users;
