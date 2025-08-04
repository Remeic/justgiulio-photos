/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const ExifReader = require("exif-reader");
const crypto = require("crypto");

// Supported image formats
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

// Calculate file hash (for caching)
function calculateFileHash(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash("md5").update(buffer).digest("hex");
}

// Get image dimensions
async function getImageDimensions(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    return {
      width: metadata.width || 0,
      height: metadata.height || 0,
      format: metadata.format || "unknown",
    };
  } catch (error) {
    console.warn(`Could not get dimensions for ${filePath}: ${error.message}`);
    return { width: 0, height: 0, format: "unknown" };
  }
}

// Normalize rational/array exif values to number/string
function toNumber(val) {
  if (val == null) return null;
  if (typeof val === "number") return val;
  if (Array.isArray(val) && val.length) return toNumber(val[0]);
  if (typeof val === "object" && "numerator" in val && "denominator" in val) {
    const d = val.denominator || 1;
    return d ? val.numerator / d : null;
  }
  return null;
}

// Extract EXIF via sharp.metadata().exif (safer than reading the full file)
async function extractExifData(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();

    if (!metadata.exif) return {};

    const exif = ExifReader.load(metadata.exif);

    const make = exif?.Image?.Make || null;
    const model = exif?.Image?.Model || null;

    const fNumber = toNumber(exif?.exif?.FNumber);
    const iso =
      exif?.exif?.ISOSpeedRatings ??
      exif?.exif?.PhotographicSensitivity ??
      null;
    const exposureTime = toNumber(exif?.exif?.ExposureTime);
    const focalLength = toNumber(exif?.exif?.FocalLength);

    // GPS values can be arrays or already-parsed decimals depending on EXIF
    const lat = exif?.gps?.GPSLatitude ?? null;
    const lon = exif?.gps?.GPSLongitude ?? null;

    const dateTaken =
      exif?.exif?.DateTimeOriginal || exif?.Image?.DateTime || null;

    return {
      camera: make && model ? `${make} ${model}` : make || model || null,
      aperture: fNumber ? `f/${fNumber}` : null,
      iso: iso ?? null,
      shutterSpeed: exposureTime ? `${exposureTime}s` : null,
      focalLength: focalLength ? `${focalLength}mm` : null,
      gps:
        lat != null && lon != null ? { latitude: lat, longitude: lon } : null,
      dateTaken,
    };
  } catch (error) {
    console.warn(`Could not extract EXIF for ${filePath}: ${error.message}`);
    return {};
  }
}

// Recursively scan directory for images
function scanDirectory(dirPath, basePath = "") {
  const items = [];

  try {
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      const relativePath = path.join(basePath, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        items.push(...scanDirectory(fullPath, relativePath));
      } else if (stat.isFile()) {
        const ext = path.extname(file).toLowerCase();
        if (IMAGE_EXTENSIONS.includes(ext)) {
          items.push({
            path: relativePath.replace(/\\/g, "/"),
            name: file,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            hash: calculateFileHash(fullPath),
          });
        }
      }
    }
  } catch (error) {
    console.error(`Error scanning directory ${dirPath}: ${error.message}`);
  }

  return items;
}

// Load existing metadata for caching
function loadExistingMetadata(rootDir) {
  const metadataPath = path.join(rootDir, "metadata.json");
  if (fs.existsSync(metadataPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      return existing.photos || [];
    } catch (error) {
      console.warn(`Could not load existing metadata: ${error.message}`);
    }
  }
  return [];
}

// Ensure thumbnails dir exists
function ensureThumbnailsDir(rootDir) {
  const thumbnailsDir = path.join(rootDir, "thumbnails");
  if (!fs.existsSync(thumbnailsDir)) {
    fs.mkdirSync(thumbnailsDir, { recursive: true });
  }
  return thumbnailsDir;
}

// Generate a JPEG thumbnail preserving aspect ratio
async function generateThumbnail(inputPath, outputPath, targetWidth = 600) {
  try {
    const meta = await sharp(inputPath).metadata();
    const aspectRatio =
      meta.width && meta.height ? meta.width / meta.height : 1;
    const targetHeight = Math.round(targetWidth / aspectRatio);

    await sharp(inputPath)
      .resize(targetWidth, targetHeight, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toFile(outputPath);

    return {
      width: targetWidth,
      height: targetHeight,
      size: fs.statSync(outputPath).size,
    };
  } catch (error) {
    console.warn(
      `Could not generate thumbnail for ${inputPath}: ${error.message}`
    );
    return null;
  }
}

// Sanitize an id from a path
function makeId(p) {
  return p.replace(/[^a-zA-Z0-9]/g, "_");
}

async function generateMetadata() {
  console.log("🔄 Starting metadata generation...");

  const repoRoot = path.join(__dirname, "..");
  const photosDir = path.join(repoRoot, "photos");
  const outputFile = path.join(repoRoot, "metadata.json");
  const thumbnailsDir = ensureThumbnailsDir(repoRoot);

  // Base URL for raw files (works on GitHub Actions and locally with fallback)
  const REPO_SLUG = process.env.GITHUB_REPOSITORY || "Remeic/justgiulio-photos";
  const RAW_BASE = `https://raw.githubusercontent.com/${REPO_SLUG}/main`;

  // Ensure photos dir exists
  if (!fs.existsSync(photosDir)) {
    console.log("📁 Creating photos directory...");
    fs.mkdirSync(photosDir, { recursive: true });
  }

  // Load existing metadata (for caching)
  const existingPhotos = loadExistingMetadata(repoRoot);
  const existingPhotoMap = new Map(existingPhotos.map((p) => [p.path, p]));

  // Scan all photos
  console.log("📸 Scanning photos directory...");
  const allPhotos = scanDirectory(photosDir);

  if (allPhotos.length === 0) {
    console.log("⚠️  No photos found in photos directory");
    const emptyMetadata = {
      generated: new Date().toISOString(),
      totalPhotos: 0,
      categories: [],
      photos: [],
      totalSize: 0,
    };
    fs.writeFileSync(outputFile, JSON.stringify(emptyMetadata, null, 2));
    console.log("✅ Generated empty metadata.json");
    return;
  }

  console.log(`📊 Found ${allPhotos.length} photos`);

  const processedPhotos = [];
  let newPhotos = 0;
  let cachedPhotos = 0;

  for (const photo of allPhotos) {
    const existingPhoto = existingPhotoMap.get(photo.path);
    const isNewOrModified = !existingPhoto || existingPhoto.hash !== photo.hash;

    const fullPath = path.join(photosDir, photo.path);

    // Always compute category from path
    const pathParts = photo.path.split("/");
    const category = pathParts.length > 1 ? pathParts[0] : "uncategorized";

    // Thumbnail: always JPEG with .jpg extension mirroring the original path
    const thumbRelPath = photo.path.replace(/\.[^.]+$/, ".jpg");
    const thumbAbsPath = path.join(thumbnailsDir, thumbRelPath);
    const thumbAbsDir = path.dirname(thumbAbsPath);
    if (!fs.existsSync(thumbAbsDir)) {
      fs.mkdirSync(thumbAbsDir, { recursive: true });
    }

    let dimensions, exif, thumbnailInfo;
    if (isNewOrModified) {
      console.log(`🆕 Processing new/modified: ${photo.path}`);
      newPhotos++;

      dimensions = await getImageDimensions(fullPath);
      exif = await extractExifData(fullPath);
      thumbnailInfo = await generateThumbnail(fullPath, thumbAbsPath);
    } else {
      // If cached, still ensure the thumbnail exists; regenerate if missing
      const missingThumbnail = !fs.existsSync(thumbAbsPath);
      if (missingThumbnail) {
        console.log(`🖼️  Missing thumbnail, regenerating: ${photo.path}`);
      } else {
        console.log(`✅ Using cached data for: ${photo.path}`);
      }
      cachedPhotos++;
      dimensions =
        existingPhoto?.dimensions || (await getImageDimensions(fullPath));
      exif = existingPhoto?.exif || (await extractExifData(fullPath));
      thumbnailInfo = missingThumbnail
        ? await generateThumbnail(fullPath, thumbAbsPath)
        : existingPhoto?.thumbnail || null;
    }

    processedPhotos.push({
      id: makeId(photo.path),
      path: photo.path,
      name: photo.name,
      category,
      size: photo.size,
      modified: photo.modified,
      hash: photo.hash,
      dimensions,
      exif,
      thumbnail: thumbnailInfo,
      url: `${RAW_BASE}/photos/${photo.path}`,
      thumbnailUrl: `${RAW_BASE}/thumbnails/${thumbRelPath}`,
    });
  }

  // Sort photos by modified date (newest first)
  processedPhotos.sort((a, b) => new Date(b.modified) - new Date(a.modified));

  // Recompute categories from processedPhotos (fixes the "categories empty" bug)
  const categoriesMap = {};
  for (const p of processedPhotos) {
    const c = p.category || "uncategorized";
    if (!categoriesMap[c]) {
      categoriesMap[c] = { name: c, photoCount: 0, totalSize: 0 };
    }
    categoriesMap[c].photoCount++;
    categoriesMap[c].totalSize += p.size;
  }
  const sortedCategories = Object.values(categoriesMap).sort(
    (a, b) => b.photoCount - a.photoCount
  );

  // Final metadata
  const metadata = {
    generated: new Date().toISOString(),
    totalPhotos: processedPhotos.length,
    totalSize: processedPhotos.reduce((sum, p) => sum + p.size, 0),
    categories: sortedCategories,
    photos: processedPhotos,
  };

  fs.writeFileSync(outputFile, JSON.stringify(metadata, null, 2));

  console.log("✅ Metadata generation completed!");
  console.log(`📦 Generated metadata for ${processedPhotos.length} photos`);
  console.log(`🆕 New/Modified photos: ${newPhotos}`);
  console.log(`♻️  Cached photos: ${cachedPhotos}`);
  console.log(
    `📁 Categories: ${sortedCategories.map((c) => c.name).join(", ")}`
  );
  console.log(
    `💾 Total size: ${(metadata.totalSize / 1024 / 1024).toFixed(2)} MB`
  );
}

generateMetadata().catch((err) => {
  console.error("❌ Unhandled error:", err);
  process.exitCode = 1;
});
