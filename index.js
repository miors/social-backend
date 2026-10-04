const express = require("express");
const path = require("path");
const app = express();

const { Pool } = require("pg");
require("dotenv").config();
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

console.log(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

app.use(cors());
app.use(express.json());

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
    res.status(201).json(result.rows[0]);
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
  const { username, password } = req.body;

  try {
    const result = await pool.query(
      `SELECT user_id, username, password_hash FROM users_social WHERE username = $1`,
      [username],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const accessToken = jwt.sign(
      { userId: user.user_id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: "15m" },
    );

    const refreshToken = jwt.sign(
      { userId: user.user_id, username: user.username },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: "7d" },
    );

    res.json({ accessToken, refreshToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.post("/friendships", verifyToken, async (req, res) => {
  console.log("called");
  const senderId = req.user.userId;
  const { receiverId } = req.body;

  if (senderId === receiverId)
    return res.status(400).json({ error: "Cannot request yourself." });

  try {
    //check if user/sender already in DB
    let result = await pool.query(
      `SELECT user_id_1, user_id_2 
   FROM friendships_social 
   WHERE (user_id_1 = $1 AND user_id_2 = $2) 
      OR (user_id_1 = $2 AND user_id_2 = $1)`,
      [senderId, receiverId],
    );

    console.log("called" + result.rows.length);

    if (result.rows.length > 0) {
      return res.status(401).json({ error: "Users are already friends" });
    }

    //add ids into friendships table
    result = await pool.query(
      `INSERT INTO friendships_social (user_id_1, user_id_2) VALUES ($1, $2) RETURNING user_id_1, user_id_2`,
      [senderId, receiverId],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

//endpoint to accept request id
app.put("/friendships/:requestorId", verifyToken, async (req, res) => {
  const { requestorId } = req.params;
  const requestorIdAsNumber = Number(requestorId);
  const { status } = req.body;
  const currentUserId = req.user.userId;

  try {
    const result = await pool.query(
      `UPDATE friendships_social SET status = COALESCE($1, status)
       WHERE (user_id_1 = $2 AND user_id_2 = $3) OR  (user_id_1 = $3 AND user_id_2 = $2) RETURNING *`,
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

app.post("/posts", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const { content, visibility } = req.body;

  try {
    result = await pool.query(
      `INSERT INTO posts_social (content, visibility, user_id) VALUES ($1, $2, $3) RETURNING *`,
      [content, visibility, userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Post not inserted" });
    }
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
      `SELECT p.post_id,
    p.content,
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
ORDER BY p.created_at DESC`,
      [userId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.listen(3000, () => {
  console.log("App is listening on port 3000");
});
