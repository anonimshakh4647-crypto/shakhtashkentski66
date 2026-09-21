const ALLOWED_ORIGINS = [
  "https://shakhtashkentski66.uz",
  "https://www.shakhtashkentski66.uz"
];

const GOOGLE_CLIENT_ID =
  "506134860126-v75qmbti4m8b0l5ms7h96hhejlj2q1jm.apps.googleusercontent.com";

const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1 GiB
const SIMPLE_UPLOAD_LIMIT = 80 * 1024 * 1024; // keep below 100 MB Worker request limit

// Only the site owner's Google account can delete files.
const DELETE_OWNER_EMAIL = "anonimshakh4647@gmail.com";

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin);
  const headers = {
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-File-Name, X-File-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (allowed) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(body, status = 200, origin = "") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      ...corsHeaders(origin)
    }
  });
}

function cleanKey(key) {
  return key
    .replace(/^\/+/, "")
    .replace(/\.\./g, "")
    .replace(/[<>:"\\|?*\x00-\x1F]/g, "_")
    .slice(0, 500);
}

async function verifyGoogleToken(request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Google login required" };
  }

  const token = auth.slice(7).trim();
  if (!token) {
    return { ok: false, status: 401, error: "Google token missing" };
  }

  try {
    const r = await fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" +
        encodeURIComponent(token)
    );

    if (!r.ok) {
      return { ok: false, status: 401, error: "Invalid Google token" };
    }

    const data = await r.json();

    if (data.aud !== GOOGLE_CLIENT_ID) {
      return { ok: false, status: 401, error: "Invalid Google client" };
    }

    if (data.email_verified !== "true" && data.email_verified !== true) {
      return { ok: false, status: 403, error: "Google email is not verified" };
    }

    if (data.exp && Number(data.exp) * 1000 < Date.now()) {
      return { ok: false, status: 401, error: "Google token expired" };
    }

    return {
      ok: true,
      user: {
        name: data.name || "",
        email: (data.email || "").toLowerCase(),
        picture: data.picture || ""
      }
    };
  } catch (e) {
    return { ok: false, status: 502, error: "Google verification failed" };
  }
}

function authKeyFromMultipartPath(url) {
  return cleanKey(decodeURIComponent(url.pathname.substring("/multipart/".length)));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const auth = await verifyGoogleToken(request);
    if (!auth.ok) {
      return json({ success: false, error: auth.error }, auth.status, origin);
    }

    try {
      // LIST
      if (request.method === "GET" && url.pathname === "/list") {
        const objects = await env.FILES.list({ limit: 1000 });
        const files = objects.objects.map(obj => ({
          name: obj.key,
          size: obj.size,
          uploaded: obj.uploaded
        }));
        return json({ success: true, user: auth.user, files }, 200, origin);
      }

      // DOWNLOAD
      if (request.method === "GET" && url.pathname.startsWith("/file/")) {
        const key = cleanKey(decodeURIComponent(url.pathname.substring(6)));
        if (!key) return json({ success: false, error: "File name missing" }, 400, origin);

        const object = await env.FILES.get(key);
        if (!object) return json({ success: false, error: "File not found" }, 404, origin);

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
        return new Response(object.body, { headers });
      }

      // SIMPLE UPLOAD (<= 80 MiB)
      if (request.method === "PUT" && url.pathname.startsWith("/upload/")) {
        const key = cleanKey(decodeURIComponent(url.pathname.substring(8)));
        if (!key) return json({ success: false, error: "File name missing" }, 400, origin);

        const contentLength = Number(request.headers.get("Content-Length") || 0);
        if (contentLength > SIMPLE_UPLOAD_LIMIT) {
          return json({
            success: false,
            error: "Fayl 80 MB dan katta. 1 GB gacha fayllar multipart upload orqali yuboriladi."
          }, 413, origin);
        }
        if (contentLength > MAX_FILE_SIZE) {
          return json({ success: false, error: "Maximum file size is 1 GB" }, 413, origin);
        }

        await env.FILES.put(key, request.body, {
          httpMetadata: {
            contentType: request.headers.get("Content-Type") || "application/octet-stream"
          },
          customMetadata: {
            uploadedBy: auth.user.email,
            uploadedByName: auth.user.name
          }
        });

        return json({
          success: true,
          message: "File uploaded successfully",
          name: key,
          uploadedBy: auth.user.email,
          url: `${url.origin}/file/${encodeURIComponent(key)}`
        }, 200, origin);
      }

      // R2 MULTIPART UPLOAD
      if (url.pathname.startsWith("/multipart/")) {
        const key = authKeyFromMultipartPath(url);
        if (!key) return json({ success: false, error: "File name missing" }, 400, origin);

        const action = url.searchParams.get("action");

        if (request.method === "POST" && action === "mpu-create") {
          const multipart = await env.FILES.createMultipartUpload(key, {
            httpMetadata: {
              contentType: request.headers.get("X-File-Type") || "application/octet-stream"
            },
            customMetadata: {
              uploadedBy: auth.user.email,
              uploadedByName: auth.user.name
            }
          });
          return json({ success: true, key: multipart.key, uploadId: multipart.uploadId }, 200, origin);
        }

        if (request.method === "PUT" && action === "mpu-uploadpart") {
          const uploadId = url.searchParams.get("uploadId");
          const partNumber = Number(url.searchParams.get("partNumber"));
          if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
            return json({ success: false, error: "Invalid uploadId or partNumber" }, 400, origin);
          }
          if (!request.body) return json({ success: false, error: "Missing request body" }, 400, origin);

          const multipart = env.FILES.resumeMultipartUpload(key, uploadId);
          const uploadedPart = await multipart.uploadPart(partNumber, request.body);
          return json({ success: true, ...uploadedPart }, 200, origin);
        }

        if (request.method === "POST" && action === "mpu-complete") {
          const uploadId = url.searchParams.get("uploadId");
          if (!uploadId) return json({ success: false, error: "Missing uploadId" }, 400, origin);

          const body = await request.json();
          if (!body || !Array.isArray(body.parts) || !body.parts.length) {
            return json({ success: false, error: "Missing multipart parts" }, 400, origin);
          }

          const parts = body.parts.map(p => ({
            partNumber: Number(p.partNumber),
            etag: String(p.etag)
          }));

          const multipart = env.FILES.resumeMultipartUpload(key, uploadId);
          const object = await multipart.complete(parts);
          return json({
            success: true,
            message: "File uploaded successfully",
            name: key,
            size: object.size,
            etag: object.httpEtag,
            uploadedBy: auth.user.email,
            url: `${url.origin}/file/${encodeURIComponent(key)}`
          }, 200, origin);
        }

        if (request.method === "DELETE" && action === "mpu-abort") {
          const uploadId = url.searchParams.get("uploadId");
          if (!uploadId) return json({ success: false, error: "Missing uploadId" }, 400, origin);
          const multipart = env.FILES.resumeMultipartUpload(key, uploadId);
          await multipart.abort();
          return new Response(null, { status: 204, headers: corsHeaders(origin) });
        }

        return json({ success: false, error: "Unknown multipart action" }, 400, origin);
      }

      // DELETE — only site owner
      if (request.method === "DELETE" && url.pathname.startsWith("/file/")) {
        const key = cleanKey(decodeURIComponent(url.pathname.substring(6)));
        if (!key) return json({ success: false, error: "File name missing" }, 400, origin);

        if (auth.user.email !== DELETE_OWNER_EMAIL.toLowerCase()) {
          return json({ success: false, error: "Delete permission denied" }, 403, origin);
        }

        const object = await env.FILES.head(key);
        if (!object) return json({ success: false, error: "File not found" }, 404, origin);

        await env.FILES.delete(key);
        return json({ success: true, message: "File deleted", name: key }, 200, origin);
      }

      return json({
        service: "IT SHAKH FILE CENTER",
        status: "online",
        storage: "Cloudflare R2",
        bucket: "shakh-files",
        security: "Google ID token required",
        maxFileSize: "1 GB",
        uploadMode: "R2 multipart for files over 80 MB",
        endpoints: {
          list: "GET /list",
          upload: "PUT /upload/FILENAME",
          multipart: "POST/PUT/DELETE /multipart/FILENAME?action=...",
          download: "GET /file/FILENAME",
          delete: "DELETE /file/FILENAME"
        }
      }, 200, origin);
    } catch (error) {
      return json({ success: false, error: error?.message || "Unknown server error" }, 500, origin);
    }
  }
};
