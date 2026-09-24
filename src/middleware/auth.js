const jwt = require("jsonwebtoken");

const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Access token missing or invalid" });
  }

  const token = authHeader.split(" ")[1];
  if (
    !token ||
    token === "null" ||
    token === "undefined" ||
    token.trim() === ""
  ) {
    return res.status(401).json({ message: "Access token missing or invalid" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET); // your secret key from .env
    req.user = decoded; // decoded contains user info: { id, email, role, etc. }
    next();
  } catch (err) {
    const expired = err?.name === "TokenExpiredError";
    return res.status(401).json({
      message: expired ? "Access token expired" : "Invalid or expired token",
    });
  }
};

module.exports = authenticateJWT;
