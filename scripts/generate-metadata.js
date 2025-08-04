/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const ExifReader = require("exif-reader"); // ✅ API corretta
const crypto = require("crypto");

const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

// ---------- helper ----------------------------------------------------------

const md5 = (file) =>
  crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex");

const getDims = async (file) => {
  try {
    const m = await sharp(file).metadata();
    return {
      width: m.width || 0,
      height: m.height || 0,
      format: m.format || "unknown",
    };
  } catch (e) {
    console.warn(`dim fail ${file}: ${e.message}`);
    return { width: 0, height: 0, format: "unknown" };
  }
};

const parseExif = async (file) => {
  try {
    const { exif, Image: img, gps } = await sharp(file).metadata();
    if (!exif) return {};

    const tags = ExifReader(exif); // ✅ niente .load
    const f = (v) => (Array.isArray(v) ? v[0] : v);

    return {
      camera:
        [tags.Image?.Make, tags.Image?.Model].filter(Boolean).join(" ") || null,
      aperture: tags.exif?.FNumber ? `f/${f(tags.exif.FNumber)}` : null,
      iso: tags.exif?.ISOSpeedRatings ?? null,
      shutterSpeed: tags.exif?.ExposureTime
        ? `${f(tags.exif.ExposureTime)}s`
        : null,
      focalLength: tags.exif?.FocalLength
        ? `${f(tags.exif.FocalLength)}mm`
        : null,
      gps:
        gps?.GPSLatitude && gps?.GPSLongitude
          ? { latitude: f(gps.GPSLatitude), longitude: f(gps.GPSLongitude) }
          : null,
      dateTaken: tags.exif?.DateTimeOriginal ?? img?.DateTime ?? null,
    };
  } catch (e) {
    console.warn(`exif fail ${file}: ${e.message}`);
    return {};
  }
};

const makeThumb = async (src, dst, w = 600) => {
  try {
    const m = await sharp(src).metadata();
    const h = Math.round(w / ((m.width || 1) / (m.height || 1)));
    await sharp(src)
      .resize(w, h, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(dst);
    return { width: w, height: h, size: fs.statSync(dst).size };
  } catch (e) {
    console.warn(`thumb fail ${src}: ${e.message}`);
    return null;
  }
};

// ---------- main ------------------------------------------------------------

(async () => {
  console.log("🔄 start");

  const root = path.join(__dirname, "..");
  const photosDir = path.join(root, "photos");
  const outFile = path.join(root, "metadata.json");
  const thumbsDir = path.join(root, "thumbnails");
  const RAW_BASE = `https://raw.githubusercontent.com/${
    process.env.GITHUB_REPOSITORY || "Remeic/justgiulio-photos"
  }/main`;

  if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true });
  if (!fs.existsSync(thumbsDir)) fs.mkdirSync(thumbsDir, { recursive: true });

  // --- scan ---
  const walk = (dir, base = "") =>
    fs.readdirSync(dir).flatMap((f) => {
      const full = path.join(dir, f);
      const rel = path.join(base, f).replace(/\\/g, "/");
      const st = fs.statSync(full);
      if (st.isDirectory()) return walk(full, rel);
      if (st.isFile() && IMAGE_EXT.includes(path.extname(f).toLowerCase()))
        return [
          {
            path: rel,
            name: f,
            size: st.size,
            modified: st.mtime.toISOString(),
            hash: md5(full),
          },
        ];
      return [];
    });

  const photos = walk(photosDir);
  if (!photos.length) {
    fs.writeFileSync(
      outFile,
      JSON.stringify(
        {
          generated: new Date().toISOString(),
          totalPhotos: 0,
          categories: [],
          photos: [],
          totalSize: 0,
        },
        null,
        2
      )
    );
    console.log("⚠️  no photos");
    return;
  }

  // --- cache ---
  const prev = fs.existsSync(outFile)
    ? JSON.parse(fs.readFileSync(outFile)).photos || []
    : [];
  const cache = new Map(prev.map((p) => [p.path, p]));

  // --- process ---
  const processed = [];
  for (const p of photos) {
    const changed = cache.get(p.path)?.hash !== p.hash;
    const full = path.join(photosDir, p.path);
    const cat = p.path.split("/")[0] || "uncategorized";
    const thumbRel = p.path.replace(/\.[^.]+$/, ".jpg");
    const thumbAbs = path.join(thumbsDir, thumbRel);
    if (!fs.existsSync(path.dirname(thumbAbs)))
      fs.mkdirSync(path.dirname(thumbAbs), { recursive: true });

    const dims = changed ? await getDims(full) : cache.get(p.path).dimensions;
    const exif = changed ? await parseExif(full) : cache.get(p.path).exif;
    const thumb = fs.existsSync(thumbAbs)
      ? changed
        ? await makeThumb(full, thumbAbs)
        : cache.get(p.path).thumbnail
      : await makeThumb(full, thumbAbs);

    processed.push({
      id: p.path.replace(/[^a-zA-Z0-9]/g, "_"),
      path: p.path,
      name: p.name,
      category: cat,
      size: p.size,
      modified: p.modified,
      hash: p.hash,
      dimensions: dims,
      exif,
      thumbnail: thumb,
      url: `${RAW_BASE}/photos/${p.path}`,
      thumbnailUrl: `${RAW_BASE}/thumbnails/${thumbRel}`,
    });
  }

  processed.sort((a, b) => new Date(b.modified) - new Date(a.modified));

  const cats = Object.values(
    processed.reduce((m, p) => {
      m[p.category] ??= { name: p.category, photoCount: 0, totalSize: 0 };
      m[p.category].photoCount++;
      m[p.category].totalSize += p.size;
      return m;
    }, {})
  ).sort((a, b) => b.photoCount - a.photoCount);

  const meta = {
    generated: new Date().toISOString(),
    totalPhotos: processed.length,
    totalSize: processed.reduce((s, p) => s + p.size, 0),
    categories: cats,
    photos: processed,
  };

  fs.writeFileSync(outFile, JSON.stringify(meta, null, 2));
  console.log(`✅ done (${processed.length} photos)`);
})();
