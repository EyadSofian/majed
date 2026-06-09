const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = process.env.PORT || 3000;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml; charset=utf-8"
};

function safePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  const requested = clean === "/" ? "/index.html" : clean;
  const filePath = path.normalize(path.join(root, requested));
  return filePath.startsWith(root) ? filePath : path.join(root, "index.html");
}

const server = http.createServer((req, res) => {
  const filePath = safePath(req.url || "/");
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
});

server.listen(port, () => {
  console.log(`Majed liquid widget preview running on port ${port}`);
});
