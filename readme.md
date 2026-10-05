To run the application open the terminal and write

# 🚀 SantaiSpace Backend API

A secure, relational backend API for a social media system built with **Node.js**, **Express**, **PostgreSQL**, and **JSON Web Tokens (JWT)**. This API supports secure authentication, relationship lifecycle management (friend requests), and a dynamic social feed with granular privacy visibility filters.

---

## 🛠️ Tech Stack & Architecture

- **Runtime:** Node.js (Express framework)
- **Database:** PostgreSQL (`pg` pool client connection)
- **Security:** `bcrypt` (12-factor key stretching hashes), `jsonwebtoken` (Dual Token Architecture)
- **CORS Configuration:** Enabled across all endpoints for headless cross-origin layout requests.

---

## 📋 Database Schema Context

The API expects the following relational PostgreSQL schema configurations:

```sql
-- 1. Users Table
CREATE TABLE users_social (
    user_id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Friendships Table
CREATE TABLE friendships_social (
    user_id_1 INT REFERENCES users_social(user_id),
    user_id_2 INT REFERENCES users_social(user_id),
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'accepted', etc.
    PRIMARY KEY (user_id_1, user_id_2),
    CHECK (user_id_1 != user_id_2)
);

-- 3. Posts Table
CREATE TABLE posts_social (
    post_id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users_social(user_id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    visibility VARCHAR(20) DEFAULT 'Public', -- 'Public', 'Friends-only'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## ⚙️ Environment Variables Setup

Create a `.env` file in the root directory of your project space:

```env
PORT=3000
DATABASE_URL=postgres://username:password@localhost:5432/your_database_name
JWT_SECRET=your_super_secure_access_token_secret_key
JWT_REFRESH_SECRET=your_even_more_secure_refresh_token_secret_key
```

---

## 🚀 Installation & Running

1. Clone the project and install all dependencies:
   ```bash
   npm install express pg dotenv cors bcrypt jsonwebtoken
   ```
2. Start the API application engine:
   ```bash
   node index.js
   ```
   _The server defaults to port `3000` (`http://localhost:3000`)._

---

## 🔑 Authentication Flow Model

This API uses a **Short-Lived Access Token** (15 minutes lifespan) alongside a **Long-Lived Refresh Token** (7 days lifespan) architecture structure to balance security with operational scaling.

1. **Sign Up / Log In:** Client receives both `token` and `refreshToken`.
2. **Protected Requests:** Client passes the short-lived access token in the headers:
   `Authorization: Bearer <token>`
3. **Expiration Recovery:** When the access token expires (401 status), the client calls `/refresh` passing the `refreshToken` payload to receive a clean new access token without forcing a visual logout prompt.

---

## 📖 API Endpoint Directory Reference

### 🔓 Public / Guest Routes

#### 1. User Sign Up

- **URL:** `/signup`
- **Method:** `POST`
- **Body Payload:**
  ```json
  {
    "username": "johndoe",
    "email": "john@example.com",
    "password": "securepassword123"
  }
  ```
- **Success Response (201):** Returns the structured profile payload (excluding sensitive hash keys).

#### 2. User Authentication Login

- **URL:** `/login`
- **Method:** `POST`
- **Body Payload:**
  ```json
  {
    "email": "john@example.com",
    "password": "securepassword123"
  }
  ```
- **Success Response (200):** Returns access and refresh keys.

#### 3. Refresh Access Token

- **URL:** `/refresh`
- **Method:** `POST`
- **Body Payload:**
  ```json
  {
    "refreshToken": "eyJhbGciOi..."
  }
  ```
- **Success Response (200):** Returns a fresh short-term `accessToken`.

---

### 🔒 Authenticated Routes (Requires `Authorization: Bearer <token>`)

#### 4. Who Am I Profiler

- **URL:** `/whoami`
- **Method:** `GET`
- **Success Response (200):** Decodes the active user identity session profile.

#### 5. Send Friend Request

- **URL:** `/friendships`
- **Method:** `POST`
- **Body Payload:**
  ```json
  {
    "receiverId": 4
  }
  ```
- **Success Response (201):** Creates a unique `pending` status friendship row linking both keys.

#### 6. Update Friend Status (Accept/Reject)

- **URL:** `/friendships/:requestorId`
- **Method:** `PUT`
- **Body Payload:**
  ```json
  {
    "status": "accepted"
  }
  ```
- **Operational Note:** Uses SQL `COALESCE` logic to selectively modify status lines while automatically handling directional column pairings (`user_id_1` / `user_id_2`).

#### 7. Create New Post

- **URL:** `/posts`
- **Method:** `POST`
- **Body Payload:**
  ```json
  {
    "title": "This is my post title.",
    "content": "Hello World! This is my post payload string.",
    "visibility": "Public" // Options: 'Public' or 'Friends-only'
  }
  ```

#### 8. Retrieve Dynamic Social Feed

- **URL:** `/posts`
- **Method:** `GET`
- **Success Response (200):** Returns an array of visible posts ordered chronologically.
- **Underlying SQL Logic Constraints:**
  - Evaluates explicit user friendships directly in a multi-directional `LEFT JOIN`.
  - Filters rows out unless the post is set to `'Public'`, **OR** set to `'Friends-only'` and an explicit `'accepted'` relationship bridge is active.
