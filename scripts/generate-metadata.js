const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const ExifReader = require("exif-reader");
const crypto = require("crypto");

// Supported image formats
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

// Function to calculate file hash for caching
function calculateFileHash(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash("md5").update(buffer).digest("hex");
}

// Function to get image dimensions
async function getImageDimensions(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    };
  } catch (error) {
    console.warn(`Could not get dimensions for ${filePath}:`, error.message);
    return { width: 0, height: 0, format: "unknown" };
  }
}

// Function to generate thumbnail with aspect ratio preservation
async function generateThumbnail(inputPath, outputPath, targetWidth = 600) {
  try {
    const metadata = await sharp(inputPath).metadata();
    const aspectRatio = metadata.width / metadata.height;
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
      `Could not generate thumbnail for ${inputPath}:`,
      error.message
    );
    return null;
  }
}

// Function to extract EXIF data
function extractExifData(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const exif = ExifReader.load(buffer);

    return {
      camera:
        exif?.Image?.Make && exif?.Image?.Model
          ? `${exif.Image.Make} ${exif.Image.Model}`
          : null,
      aperture: exif?.exif?.FNumber ? `f/${exif.exif.FNumber}` : null,
      iso: exif?.exif?.ISOSpeedRatings || null,
      shutterSpeed: exif?.exif?.ExposureTime
        ? `${exif.exif.ExposureTime}s`
        : null,
      focalLength: exif?.exif?.FocalLength
        ? `${exif.exif.FocalLength}mm`
        : null,
      gps: exif?.gps
        ? {
            latitude: exif.gps.GPSLatitude,
            longitude: exif.gps.GPSLongitude,
          }
        : null,
      dateTaken: exif?.exif?.DateTimeOriginal || exif?.Image?.DateTime || null,
    };
  } catch (error) {
    console.warn(`Could not extract EXIF for ${filePath}:`, error.message);
    return {};
  }
}

// Function to scan directory recursively
function scanDirectory(dirPath, basePath = "") {
  const items = [];

  try {
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      const relativePath = path.join(basePath, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        // Recursively scan subdirectories
        const subItems = scanDirectory(fullPath, relativePath);
        items.push(...subItems);
      } else if (stat.isFile()) {
        const ext = path.extname(file).toLowerCase();
        if (IMAGE_EXTENSIONS.includes(ext)) {
          items.push({
            path: relativePath.replace(/\\/g, "/"), // Normalize path separators
            name: file,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            hash: calculateFileHash(fullPath),
          });
        }
      }
    }
  } catch (error) {
    console.error(`Error scanning directory ${dirPath}:`, error.message);
  }

  return items;
}

// Function to load existing metadata for caching
function loadExistingMetadata() {
  const metadataPath = path.join(__dirname, "..", "metadata.json");
  if (fs.existsSync(metadataPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      return existing.photos || [];
    } catch (error) {
      console.warn("Could not load existing metadata:", error.message);
    }
  }
  return [];
}

// Function to create thumbnails directory
function ensureThumbnailsDir() {
  const thumbnailsDir = path.join(__dirname, "..", "thumbnails");
  if (!fs.existsSync(thumbnailsDir)) {
    fs.mkdirSync(thumbnailsDir, { recursive: true });
  }
  return thumbnailsDir;
}

// Main function to generate metadata
async function generateMetadata() {
  console.log("🔄 Starting metadata generation...");

  const photosDir = path.join(__dirname, "..", "photos");
  const outputFile = path.join(__dirname, "..", "metadata.json");
  const thumbnailsDir = ensureThumbnailsDir();

  // Check if photos directory exists
  if (!fs.existsSync(photosDir)) {
    console.log("📁 Creating photos directory...");
    fs.mkdirSync(photosDir, { recursive: true });
  }

  // Load existing metadata for caching
  const existingPhotos = loadExistingMetadata();
  const existingPhotoMap = new Map(
    existingPhotos.map((photo) => [photo.path, photo])
  );

  // Scan all photos
  console.log("📸 Scanning photos directory...");
  const allPhotos = scanDirectory(photosDir);

  if (allPhotos.length === 0) {
    console.log("⚠️  No photos found in photos directory");
    // Create empty metadata structure
    const emptyMetadata = {
      generated: new Date().toISOString(),
      totalPhotos: 0,
      categories: {},
      photos: [],
    };

    fs.writeFileSync(outputFile, JSON.stringify(emptyMetadata, null, 2));
    console.log("✅ Generated empty metadata.json");
    return;
  }

  console.log(`📊 Found ${allPhotos.length} photos`);

  // Process each photo with caching
  const processedPhotos = [];
  const categories = {};
  let newPhotos = 0;
  let cachedPhotos = 0;

  for (const photo of allPhotos) {
    const existingPhoto = existingPhotoMap.get(photo.path);
    const isNewOrModified = !existingPhoto || existingPhoto.hash !== photo.hash;

    if (isNewOrModified) {
      console.log(`�� Processing new/modified: ${photo.path}`);
      newPhotos++;

      const fullPath = path.join(photosDir, photo.path);

      // Get image dimensions
      const dimensions = await getImageDimensions(fullPath);

      // Extract EXIF data
      const exif = extractExifData(fullPath);

      // Generate thumbnail
      const thumbnailPath = path.join(thumbnailsDir, photo.path);
      const thumbnailDir = path.dirname(thumbnailPath);
      if (!fs.existsSync(thumbnailDir)) {
        fs.mkdirSync(thumbnailDir, { recursive: true });
      }

      const thumbnailInfo = await generateThumbnail(fullPath, thumbnailPath);

      // Determine category from path
      const pathParts = photo.path.split("/");
      const category = pathParts.length > 1 ? pathParts[0] : "uncategorized";

      // Initialize category if not exists
      if (!categories[category]) {
        categories[category] = {
          name: category,
          photoCount: 0,
          totalSize: 0,
        };
      }

      // Update category stats
      categories[category].photoCount++;
      categories[category].totalSize += photo.size;

      // Create photo object
      const photoData = {
        id: photo.path.replace(/[^a-zA-Z0-9]/g, "_"),
        path: photo.path,
        name: photo.name,
        category,
        size: photo.size,
        modified: photo.modified,
        hash: photo.hash,
        dimensions,
        exif,
        thumbnail: thumbnailInfo,
        url: `https://raw.githubusercontent.com/Remeic/justgiulio-photos/main/photos/${photo.path}`,
        thumbnailUrl: `https://raw.githubusercontent.com/Remeic/justgiulio-photos/main/thumbnails/${photo.path}`,
      };

      processedPhotos.push(photoData);
    } else {
      console.log(`✅ Using cached data for: ${photo.path}`);
      cachedPhotos++;
      processedPhotos.push(existingPhoto);
    }
  }

  // Sort photos by date (newest first)
  processedPhotos.sort((a, b) => new Date(b.modified) - new Date(a.modified));

  // Sort categories by photo count
  const sortedCategories = Object.values(categories).sort(
    (a, b) => b.photoCount - a.photoCount
  );

  // Create final metadata structure
  const metadata = {
    generated: new Date().toISOString(),
    totalPhotos: processedPhotos.length,
    totalSize: processedPhotos.reduce((sum, photo) => sum + photo.size, 0),
    categories: sortedCategories,
    photos: processedPhotos,
  };

  // Write metadata file
  fs.writeFileSync(outputFile, JSON.stringify(metadata, null, 2));

  console.log("✅ Metadata generation completed!");
  console.log(`�� Generated metadata for ${processedPhotos.length} photos`);
  console.log(`🆕 New/Modified photos: ${newPhotos}`);
  console.log(`�� Cached photos: ${cachedPhotos}`);
  console.log(`📁 Categories: ${Object.keys(categories).join(", ")}`);
  console.log(
    `💾 Total size: ${(metadata.totalSize / 1024 / 1024).toFixed(2)} MB`
  );
}

// Run the script
generateMetadata().catch(console.error);
