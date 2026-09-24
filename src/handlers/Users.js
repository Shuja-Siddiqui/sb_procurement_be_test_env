const prisma = require("../lib/prisma");
const Response = require("./Response");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Role } = require("@prisma/client");

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

  checkUserDuplicates = async ({ name, number, cnic, excludeUserId = null }) => {
    const trimmedName = String(name || "").trim();
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
      const { name, password, role, cnic, gender, number, status, alreadyAssigned, isEdit } = req.body;

      const duplicateFields = await this.checkUserDuplicates({ name, number, cnic });
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
          email: this.buildInternalEmail({ name, number }),
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
      const { name, password, role, cnic, gender, number, status, alreadyAssigned, isEdit } = req.body;

      const duplicateFields = await this.checkUserDuplicates({
        name,
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
