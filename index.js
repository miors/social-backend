const express = require("express");
const path = require("path");
const app = express();
const { randomUUID } = require("crypto");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const { Pool } = require("pg");
require("dotenv").config();
const cors = require("cors");
app.use(cors());
app.use(express.json());

const supabaseStorage = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(request, file, callback) {
    if (!file.mimetype.startsWith("image/")) {
      return callback(new Error("Only image files are allowed"));
    }
    callback(null, true);
  },
});

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

// console.log(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/signup", async (req, res) => {
  const { username, password, email } = req.body;
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO users_social (username, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id, username, email",
      [username, email, hash],
    );
    const user = result.rows[0];

    const token = jwt.sign(
      { userId: user.user_id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: "15m" },
    );

    const refreshToken = jwt.sign(
      { userId: user.user_id, username: user.username },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: "7d" },
    );

    res.status(201).json({ token, refreshToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.post("/refresh", (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(401).json({ error: "Missing refresh token" });
  }
  jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, (err, decoded) => {
    if (err) {
      return res
        .status(401)
        .json({ error: "Invalid or expired refresh token" });
    }
    const accessToken = jwt.sign(
      { userId: decoded.userId, username: decoded.username },
      process.env.JWT_SECRET,
      { expiresIn: "15m" },
    );
    res.json({ accessToken });
  });
});

function verifyToken(req, res, next) {
  const auth = req.headers.authorization;

  if (!auth) return res.status(401).end();
  const token = auth.split(" ")[1];

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).end();
    req.user = decoded;

    next();
  });
}

app.get("/whoami", verifyToken, (req, res) => {
  res.json({ userId: req.user.userId, username: req.user.username });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query(
      `SELECT user_id, username, password_hash FROM users_social WHERE email = $1`,
      [email],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const user = result.rows[0];

    if (
      !user.password_hash ||
      !(await bcrypt.compare(password, user.password_hash))
    ) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const token = jwt.sign(
      { userId: user.user_id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: "15m" },
    );

    const refreshToken = jwt.sign(
      { userId: user.user_id, username: user.username },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: "7d" },
    );

    res.json({ token, refreshToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.post("/auth/oauth/exchange", async (req, res) => {
  const authorization = req.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({ error: "Missing Supabase access token" });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY) {
    return res.status(500).json({ error: "OAuth is not configured" });
  }

  let client;

  try {
    const supabaseResponse = await fetch(
      `${process.env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`,
      {
        headers: {
          apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${match[1]}`,
        },
      },
    );

    if (!supabaseResponse.ok) {
      return res.status(401).json({ error: "Invalid Supabase access token" });
    }

    const supabaseUser = await supabaseResponse.json();
    const email = supabaseUser.email?.trim().toLowerCase();

    const isGoogleUser =
      supabaseUser.app_metadata?.provider === "google" ||
      supabaseUser.identities?.some(
        (identity) => identity.provider === "google",
      );

    if (
      !supabaseUser.id ||
      !email ||
      !supabaseUser.email_confirmed_at ||
      !isGoogleUser
    ) {
      return res.status(401).json({
        error: "A verified Google account is required",
      });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    let userResult = await client.query(
      `SELECT user_id, username, supabase_user_id
       FROM users_social
       WHERE supabase_user_id = $1
       FOR UPDATE`,
      [supabaseUser.id],
    );

    let user = userResult.rows[0];

    if (!user) {
      const emailResult = await client.query(
        `SELECT user_id, username, supabase_user_id
         FROM users_social
         WHERE LOWER(email) = LOWER($1)
         FOR UPDATE`,
        [email],
      );

      if (emailResult.rows.length > 1) {
        const error = new Error("Multiple accounts match this email");
        error.status = 409;
        throw error;
      }

      const existingUser = emailResult.rows[0];

      if (existingUser) {
        if (
          existingUser.supabase_user_id &&
          existingUser.supabase_user_id !== supabaseUser.id
        ) {
          const error = new Error("This account is linked to another identity");
          error.status = 409;
          throw error;
        }

        userResult = await client.query(
          `UPDATE users_social
           SET supabase_user_id = $1
           WHERE user_id = $2
           RETURNING user_id, username, supabase_user_id`,
          [supabaseUser.id, existingUser.user_id],
        );
        user = userResult.rows[0];
      } else {
        const displayName =
          supabaseUser.user_metadata?.user_name ||
          supabaseUser.user_metadata?.name ||
          email.split("@")[0];

        const usernameBase =
          String(displayName)
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, "")
            .slice(0, 40) || "runner";
        const username = `${usernameBase}_${supabaseUser.id
          .replace(/-/g, "")
          .slice(0, 8)}`;

        userResult = await client.query(
          `INSERT INTO users_social
             (username, email, password_hash, supabase_user_id)
           VALUES ($1, $2, NULL, $3)
           RETURNING user_id, username, supabase_user_id`,
          [username, email, supabaseUser.id],
        );
        user = userResult.rows[0];
      }
    }

    await client.query("COMMIT");

    const token = jwt.sign(
      { userId: user.user_id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: "15m" },
    );

    const refreshToken = jwt.sign(
      { userId: user.user_id, username: user.username },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: "7d" },
    );

    return res.json({ token, refreshToken });
  } catch (err) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    if (err.code === "23505") {
      return res.status(409).json({
        error: "Account already exists or is linked; retry sign-in",
      });
    }

    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }

    console.error("OAuth token exchange failed:", err);
    return res.status(500).json({ error: "Something went wrong" });
  } finally {
    client?.release();
  }
});

app.post("/friendships", verifyToken, async (req, res) => {
  const senderId = req.user.userId;
  const { receiverId } = req.body;

  if (senderId === receiverId) {
    return res.status(400).json({ error: "Cannot request yourself." });
  }

  try {
    // Check if any relationship already exists between the two users
    const result = await pool.query(
      `SELECT * FROM friendships_social 
       WHERE (user_id_1 = $1 AND user_id_2 = $2) 
          OR (user_id_1 = $2 AND user_id_2 = $1)`,
      [senderId, receiverId],
    );

    if (result.rows.length > 0) {
      const existing = result.rows[0];

      // Case 1: They are already officially friends
      if (existing.status === "accepted") {
        return res.status(400).json({ error: "Users are already friends." });
      }

      // Case 2: The current user already sent a pending request
      if (
        Number(existing.user_id_1) === Number(senderId) &&
        existing.status === "pending"
      ) {
        return res
          .status(400)
          .json({ error: "Friend request is already pending." });
      }

      // Case 3: The OTHER user sent a pending friend's request, and current user is now accepting it.
      // This makes them mutual friends! Auto-accept it.
      if (
        Number(existing.user_id_2) === Number(senderId) &&
        existing.status === "pending"
      ) {
        const updateResult = await pool.query(
          `UPDATE friendships_social 
           SET status = 'accepted' 
           WHERE user_id_1 = $1 AND user_id_2 = $2
           RETURNING *`,
          [existing.user_id_1, existing.user_id_2],
        );
        // WHERE user_id_1 = $1 AND user_id_2 = $2
        // WHERE user_id_1 = $2 AND user_id_2 = $1
        // WHERE (user_id_1 = $1 AND user_id_2 = $2) OR (user_id_1 = $2 AND user_id_2 = $1)
        return res.status(200).json(updateResult.rows[0]); // return object, not array
      }
    }

    // Case 4: No previous relationship exists. Insert a brand new pending request.
    const insertResult = await pool.query(
      `INSERT INTO friendships_social (user_id_1, user_id_2, status) 
       VALUES ($1, $2, 'pending') 
       RETURNING *`,
      [senderId, receiverId],
    );

    res.status(201).json(insertResult.rows[0]); // return object, not array
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.put("/friendships/:requestorId", verifyToken, async (req, res) => {
  const { requestorId } = req.params;
  const requestorIdAsNumber = Number(requestorId);
  const { status } = req.body;
  const currentUserId = req.user.userId;

  try {
    const result = await pool.query(
      `UPDATE friendships_social SET status = COALESCE($1, status)
       WHERE user_id_1 = $3 AND user_id_2 = $2 RETURNING *`,
      [status, currentUserId, requestorIdAsNumber],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Friendship not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.post("/posts", verifyToken, upload.single("image"), async (req, res) => {
  const userId = req.user.userId;
  const { title, content, visibility } = req.body;
  let objectPath;

  if (!title?.trim() || !content?.trim()) {
    return res.status(400).json({ error: "Title and content are required" });
  }

  if (!["Public", "Friends-only"].includes(visibility)) {
    return res.status(400).json({ error: "Invalid visibility" });
  }

  try {
    let imgUrl = null;

    if (req.file) {
      objectPath = `${userId}/${randomUUID()}`;

      const { error: uploadError } = await supabaseStorage.storage
        .from("post-images")
        .upload(objectPath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false,
        });

      if (uploadError) throw uploadError;

      imgUrl = supabaseStorage.storage
        .from("post-images")
        .getPublicUrl(objectPath).data.publicUrl;
    }

    const result = await pool.query(
      `INSERT INTO posts_social
        (title, content, visibility, user_id, img_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [title.trim(), content.trim(), visibility, userId, imgUrl],
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    if (objectPath) {
      const { error: cleanupError } = await supabaseStorage.storage
        .from("post-images")
        .remove([objectPath]);

      if (cleanupError) console.error("Image cleanup failed:", cleanupError);
    }

    console.error("Post creation failed:", err);
    return res.status(500).json({ error: "Could not create post" });
  }
});

app.delete("/posts/:id", verifyToken, async (req, res) => {
  const postId = Number(req.params.id);
  if (!Number.isSafeInteger(postId) || postId <= 0) {
    return res.status(400).json({ error: "Invalid post ID" });
  }

  try {
    const result = await pool.query(
      "DELETE FROM posts_social WHERE post_id = $1 AND user_id = $2 RETURNING post_id",
      [postId, req.user.userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    res.status(204).end();
  } catch (err) {
    console.error(err);
    if (err.code === "23503") {
      return res.status(409).json({
        error: "Post is referenced by another record and cannot be deleted",
      });
    }
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.get("/users", verifyToken, async (req, res) => {
  const currentUserId = req.user.userId;
  try {
    const result = await pool.query(
      `SELECT 
        u.user_id, 
        u.username, 
        u.email,
        f.status AS friendship_status,
        f.user_id_1 AS request_sender
       FROM users_social u
       LEFT JOIN friendships_social f ON 
         (f.user_id_1 = $1 AND f.user_id_2 = u.user_id) OR 
         (f.user_id_2 = $1 AND f.user_id_1 = u.user_id)
       WHERE u.user_id != $1`, // Hides the current logged-in user from the discover list
      [currentUserId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.get("/profile", verifyToken, async (req, res) => {
  const currentUserId = req.user.userId;
  try {
    const result = await pool.query(
      `SELECT 
        u.user_id, 
        u.username, 
        u.email,
        r.average_heart_rate AS average_heart_rate,
        r.experience_level AS experience_level
       FROM users_social u
       LEFT JOIN runs_social r ON 
         u.user_id = r.user_id
       WHERE u.user_id = $1`,
      [currentUserId],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.get("/posts", verifyToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    const result = await pool.query(
      `SELECT p.post_id, p.title,
    p.content,
    p.img_url,
    p.visibility,
    p.created_at,
    u.user_id,
    u.username
FROM posts_social p
INNER JOIN users_social u ON p.user_id = u.user_id
LEFT JOIN friendships_social f ON (
    (f.user_id_1 = p.user_id AND f.user_id_2 = $1) OR 
    (f.user_id_2 = p.user_id AND f.user_id_1 = $1)
) AND f.status = 'accepted'
WHERE 
    p.visibility = 'Public' 
    OR (p.visibility = 'Friends-only' AND f.status = 'accepted')
    OR p.user_id = $1
ORDER BY p.created_at DESC`,
      [userId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("App is listening on port 3000");
});
