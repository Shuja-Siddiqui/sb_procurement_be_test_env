require("../config/env"); // ensure .env is loaded before reading UPLOADS_DIR
const fs = require("fs");
const path = require("path");

// Folder name from backend .env → UPLOADS_DIR (e.g. site-agreements)
const getUploadsDir = () => {
  const rawDir = String(process.env.UPLOADS_DIR || "uploads").trim();
  if (!rawDir) return "uploads";

  // If it's an absolute path, keep the leading slash(es) but trim trailing slashes
  if (path.isAbsolute(rawDir)) {
    return path.normalize(rawDir);
  }

  // Otherwise, safely strip leading/trailing slashes for relative directories
  return rawDir.replace(/^[/\\]+|[/\\]+$/g, "") || "uploads";
};

const UPLOADS_DIR = getUploadsDir();
const UPLOADS_ROOT = path.resolve(UPLOADS_DIR);

if (!fs.existsSync(UPLOADS_ROOT)) {
  fs.mkdirSync(UPLOADS_ROOT, { recursive: true });
}

console.log(`[uploads] UPLOADS_DIR=${UPLOADS_DIR} → ${UPLOADS_ROOT}`);

const ensureUploadsDir = (subDir = "") => {
  const targetDir = subDir
    ? path.join(UPLOADS_ROOT, subDir)
    : UPLOADS_ROOT;
  fs.mkdirSync(targetDir, { recursive: true });
  return targetDir;
};

const sanitizeFileName = (name, fallback = "file") =>
  String(name || fallback)
    .replace(/[^\w.\-]+/g, "_")
    .slice(0, 120) || fallback;

/**
 * Save a buffer to the backend uploads folder.
 * @returns {{ absolutePath: string, relativePath: string, fileName: string, publicUrlPath: string }}
 */
const saveToUploads = (buffer, originalName, options = {}) => {
  const { subDir = "", prefix = "" } = options;
  const targetDir = ensureUploadsDir(subDir);
  const safeName = sanitizeFileName(originalName, "document.pdf");
  const uniquePrefix =
    prefix ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const fileName = `${uniquePrefix}-${safeName}`;
  const absolutePath = path.join(targetDir, fileName);
  fs.writeFileSync(absolutePath, buffer);

  const relativePath = subDir
    ? path.posix.join(subDir.replace(/\\/g, "/"), fileName)
    : fileName;

  return {
    absolutePath,
    relativePath,
    fileName,
    publicUrlPath: `/${UPLOADS_DIR}/${relativePath}`,
  };
};

const deleteFromUploads = (relativePath) => {
  if (!relativePath) return false;
  const cleaned = String(relativePath)
    .replace(/^[/\\]+/, "")
    .replace(new RegExp(`^${UPLOADS_DIR}[/\\\\]`, "i"), "");
  const absolutePath = path.join(UPLOADS_ROOT, cleaned);
  if (!absolutePath.startsWith(UPLOADS_ROOT)) return false;
  if (!fs.existsSync(absolutePath)) return false;
  fs.unlinkSync(absolutePath);
  return true;
};

const findUploadByPrefix = (prefix, subDir = "") => {
  if (!prefix) return null;
  const targetDir = ensureUploadsDir(subDir);
  const match = fs
    .readdirSync(targetDir)
    .find((name) => name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}_`));
  if (!match) return null;
  return path.join(targetDir, match);
};

const deleteUploadByPrefix = (prefix, subDir = "") => {
  const absolutePath = findUploadByPrefix(prefix, subDir);
  if (!absolutePath || !fs.existsSync(absolutePath)) return false;
  fs.unlinkSync(absolutePath);
  return true;
};

module.exports = {
  UPLOADS_DIR,
  UPLOADS_ROOT,
  ensureUploadsDir,
  sanitizeFileName,
  saveToUploads,
  deleteFromUploads,
  findUploadByPrefix,
  deleteUploadByPrefix,
};