/**
 * Shared helpers for file upload paths and disk storage.
 * Centralizes the uploads base directory and filename convention.
 */
import path from "path";
import fs from "fs";
import multer from "multer";

/** Absolute path to the base uploads directory. */
export function getUploadsBaseDir() {
  return path.resolve(process.cwd(), "uploads");
}

/**
 * Create a disk storage adapter with a consistent destination and filename scheme.
 * @param {string} prefix Prefix used in generated filenames (e.g., 'kb', 'file', 'img')
 */
export function makeDiskStorage(prefix = "file") {
  const baseDir = getUploadsBaseDir();
  return multer.diskStorage({
    destination: (_req, _file, cb) => {
      if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
      }
      cb(null, baseDir);
    },
    filename: (_req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, `${prefix}-${uniqueSuffix}${path.extname(file.originalname)}`);
    }
  });
}

/**
 * Select a storage implementation based on the environment.
 * Uses in-memory storage in serverless environments, else disk.
 * @param {string} prefix filename prefix when using disk storage
 */
export function selectStorage(prefix = "file") {
  return process.env.VERCEL ? multer.memoryStorage() : makeDiskStorage(prefix);
}

export default {
  getUploadsBaseDir,
  makeDiskStorage,
  selectStorage
};

