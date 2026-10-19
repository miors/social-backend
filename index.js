const express = require("express");
const path = require("path");
const app = express();

const { Pool } = require("pg");
require("dotenv").config();
const cors = require("cors");
const bcrypt = require("bcrypt");

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

app.listen(3000, () => {
  console.log("App is listening on port 3000");
});
