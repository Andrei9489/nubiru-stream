require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static("public"));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret";

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.replace("Bearer ", "");

  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contents (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      poster_url TEXT,
      backdrop_url TEXT,
      type TEXT DEFAULT 'movie',
      iframe_url TEXT,
      source_url TEXT,
      year INT,
      genre TEXT,
      tmdb_id TEXT,
      imdb_id TEXT,
      youtube_trailer TEXT,
      category TEXT,
      subcategory TEXT,
      genres TEXT,
      actors TEXT,
      director TEXT,
      country TEXT,
      language TEXT,
      rating TEXT,
      tags TEXT,
      collection TEXT,
      channel TEXT,
      age_rating TEXT,
      quality TEXT,
      season INT,
      episode INT,
      views INT DEFAULT 0,
      popularity INT DEFAULT 0,
      is_featured BOOLEAN DEFAULT false,
      is_trending BOOLEAN DEFAULT false,
      updated_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      content_id INT REFERENCES contents(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, content_id)
    );

    CREATE TABLE IF NOT EXISTS watch_history (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      content_id INT REFERENCES contents(id) ON DELETE CASCADE,
      progress_seconds INT DEFAULT 0,
      duration_seconds INT DEFAULT 0,
      completed BOOLEAN DEFAULT false,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, content_id)
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      favorite_genres TEXT,
      favorite_categories TEXT,
      favorite_countries TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id)
    );
  `);

  console.log("Nubiru ULTRA database ready");
}

app.get("/health", async (req, res) => {
  const result = await pool.query("SELECT NOW()");
  res.json({ ok: true, database_time: result.rows[0].now });
});

/* AUTH */
app.post("/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1,$2,$3)
       RETURNING id, name, email, role, created_at`,
      [name || "", email.toLowerCase(), passwordHash]
    );

    const user = result.rows[0];
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: "30d" });

    res.json({ user, token });
  } catch (err) {
    res.status(500).json({ error: "Register error", details: err.message });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email.toLowerCase()]
    );

    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid login" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid login" });

    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      created_at: user.created_at,
    };

    const token = jwt.sign(safeUser, JWT_SECRET, { expiresIn: "30d" });

    res.json({ user: safeUser, token });
  } catch (err) {
    res.status(500).json({ error: "Login error", details: err.message });
  }
});

app.get("/auth/me", auth, async (req, res) => {
  res.json({ user: req.user });
});

/* CONTENT */
app.get("/content", async (req, res) => {
  const result = await pool.query("SELECT * FROM contents ORDER BY created_at DESC");
  res.json(result.rows);
});

app.get("/content/search", async (req, res) => {
  try {
    const {
      q, type, category, genre, country, language,
      actor, director, collection, channel, year, sort
    } = req.query;

    const conditions = [];
    const values = [];

    function addLike(field, value) {
      if (!value) return;
      values.push(`%${value}%`);
      conditions.push(`${field} ILIKE $${values.length}`);
    }

    if (q) {
      values.push(`%${q}%`);
      conditions.push(`(
        title ILIKE $${values.length}
        OR description ILIKE $${values.length}
        OR genre ILIKE $${values.length}
        OR genres ILIKE $${values.length}
        OR tags ILIKE $${values.length}
        OR actors ILIKE $${values.length}
        OR director ILIKE $${values.length}
        OR collection ILIKE $${values.length}
        OR channel ILIKE $${values.length}
        OR country ILIKE $${values.length}
      )`);
    }

    addLike("type", type);
    addLike("category", category);
    addLike("genres", genre);
    addLike("country", country);
    addLike("language", language);
    addLike("actors", actor);
    addLike("director", director);
    addLike("collection", collection);
    addLike("channel", channel);

    if (year) {
      values.push(Number(year));
      conditions.push(`year = $${values.length}`);
    }

    let orderBy = "created_at DESC";
    if (sort === "oldest") orderBy = "created_at ASC";
    if (sort === "year_desc") orderBy = "year DESC NULLS LAST";
    if (sort === "year_asc") orderBy = "year ASC NULLS LAST";
    if (sort === "popular") orderBy = "popularity DESC NULLS LAST, views DESC NULLS LAST";
    if (sort === "views") orderBy = "views DESC NULLS LAST";
    if (sort === "rating") orderBy = "rating DESC NULLS LAST";

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const result = await pool.query(
      `SELECT * FROM contents ${where} ORDER BY ${orderBy} LIMIT 300`,
      values
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Search error", details: err.message });
  }
});

app.get("/content/autocomplete", async (req, res) => {
  try {
    const q = req.query.q || "";
    if (!q) return res.json([]);

    const result = await pool.query(
      `SELECT DISTINCT title, category, year, poster_url
       FROM contents
       WHERE title ILIKE $1
          OR actors ILIKE $1
          OR director ILIKE $1
          OR genres ILIKE $1
          OR collection ILIKE $1
       ORDER BY title ASC
       LIMIT 10`,
      [`%${q}%`]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Autocomplete error", details: err.message });
  }
});

app.post("/content", async (req, res) => {
  try {
    const b = req.body;

    const result = await pool.query(
      `INSERT INTO contents
      (
        title, description, poster_url, backdrop_url, type,
        iframe_url, source_url, year, genre, tmdb_id, imdb_id, youtube_trailer,
        category, subcategory, genres, actors, director, country, language,
        rating, tags, collection, channel, age_rating, quality,
        season, episode, popularity, is_featured, is_trending
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
      RETURNING *`,
      [
        b.title, b.description, b.poster_url, b.backdrop_url, b.type || "movie",
        b.iframe_url, b.source_url, b.year || null, b.genre, b.tmdb_id, b.imdb_id,
        b.youtube_trailer, b.category, b.subcategory, b.genres, b.actors,
        b.director, b.country, b.language, b.rating, b.tags, b.collection,
        b.channel, b.age_rating, b.quality, b.season || null, b.episode || null,
        b.popularity || 0, b.is_featured || false, b.is_trending || false,
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Error adding content", details: err.message });
  }
});

app.put("/content/:id", async (req, res) => {
  try {
    const b = req.body;

    const result = await pool.query(
      `UPDATE contents SET
        title=$1, description=$2, poster_url=$3, backdrop_url=$4, type=$5,
        iframe_url=$6, source_url=$7, year=$8, genre=$9, tmdb_id=$10,
        imdb_id=$11, youtube_trailer=$12, category=$13, subcategory=$14,
        genres=$15, actors=$16, director=$17, country=$18, language=$19,
        rating=$20, tags=$21, collection=$22, channel=$23, age_rating=$24,
        quality=$25, season=$26, episode=$27, popularity=$28,
        is_featured=$29, is_trending=$30, updated_at=NOW()
       WHERE id=$31 RETURNING *`,
      [
        b.title, b.description, b.poster_url, b.backdrop_url, b.type || "movie",
        b.iframe_url, b.source_url, b.year || null, b.genre, b.tmdb_id, b.imdb_id,
        b.youtube_trailer, b.category, b.subcategory, b.genres, b.actors,
        b.director, b.country, b.language, b.rating, b.tags, b.collection,
        b.channel, b.age_rating, b.quality, b.season || null, b.episode || null,
        b.popularity || 0, b.is_featured || false, b.is_trending || false,
        req.params.id,
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Error updating content", details: err.message });
  }
});

app.delete("/content/:id", async (req, res) => {
  await pool.query("DELETE FROM contents WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

app.post("/content/:id/view", async (req, res) => {
  const result = await pool.query(
    "UPDATE contents SET views = COALESCE(views,0)+1, popularity = COALESCE(popularity,0)+1 WHERE id=$1 RETURNING views, popularity",
    [req.params.id]
  );
  res.json(result.rows[0]);
});

/* WATCHLIST */
app.get("/watchlist", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT c.*
     FROM watchlist w
     JOIN contents c ON c.id = w.content_id
     WHERE w.user_id=$1
     ORDER BY w.created_at DESC`,
    [req.user.id]
  );
  res.json(result.rows);
});

app.post("/watchlist/:contentId", auth, async (req, res) => {
  await pool.query(
    `INSERT INTO watchlist (user_id, content_id)
     VALUES ($1,$2)
     ON CONFLICT (user_id, content_id) DO NOTHING`,
    [req.user.id, req.params.contentId]
  );
  res.json({ ok: true });
});

app.delete("/watchlist/:contentId", auth, async (req, res) => {
  await pool.query(
    "DELETE FROM watchlist WHERE user_id=$1 AND content_id=$2",
    [req.user.id, req.params.contentId]
  );
  res.json({ ok: true });
});

/* CONTINUE WATCHING */
app.get("/history", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT h.*, c.title, c.poster_url, c.backdrop_url, c.iframe_url, c.youtube_trailer, c.source_url
     FROM watch_history h
     JOIN contents c ON c.id = h.content_id
     WHERE h.user_id=$1
     ORDER BY h.updated_at DESC`,
    [req.user.id]
  );
  res.json(result.rows);
});

app.post("/history/:contentId", auth, async (req, res) => {
  const { progress_seconds, duration_seconds, completed } = req.body;

  const result = await pool.query(
    `INSERT INTO watch_history
      (user_id, content_id, progress_seconds, duration_seconds, completed, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (user_id, content_id)
     DO UPDATE SET
      progress_seconds=$3,
      duration_seconds=$4,
      completed=$5,
      updated_at=NOW()
     RETURNING *`,
    [
      req.user.id,
      req.params.contentId,
      progress_seconds || 0,
      duration_seconds || 0,
      completed || false,
    ]
  );

  res.json(result.rows[0]);
});

/* PREFERENCES + RECOMMENDATIONS */
app.post("/preferences", auth, async (req, res) => {
  const { favorite_genres, favorite_categories, favorite_countries } = req.body;

  const result = await pool.query(
    `INSERT INTO user_preferences
      (user_id, favorite_genres, favorite_categories, favorite_countries, updated_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET
      favorite_genres=$2,
      favorite_categories=$3,
      favorite_countries=$4,
      updated_at=NOW()
     RETURNING *`,
    [req.user.id, favorite_genres, favorite_categories, favorite_countries]
  );

  res.json(result.rows[0]);
});

app.get("/recommendations", auth, async (req, res) => {
  try {
    const prefs = await pool.query(
      "SELECT * FROM user_preferences WHERE user_id=$1",
      [req.user.id]
    );

    const history = await pool.query(
      `SELECT c.genres, c.category, c.country
       FROM watch_history h
       JOIN contents c ON c.id=h.content_id
       WHERE h.user_id=$1
       ORDER BY h.updated_at DESC
       LIMIT 20`,
      [req.user.id]
    );

    const terms = [];

    if (prefs.rows[0]) {
      ["favorite_genres", "favorite_categories", "favorite_countries"].forEach(k => {
        if (prefs.rows[0][k]) {
          prefs.rows[0][k].split(",").forEach(x => terms.push(x.trim()));
        }
      });
    }

    history.rows.forEach(x => {
      if (x.genres) x.genres.split(",").forEach(g => terms.push(g.trim()));
      if (x.category) terms.push(x.category);
      if (x.country) terms.push(x.country);
    });

    const clean = [...new Set(terms.filter(Boolean))].slice(0, 12);

    if (!clean.length) {
      const fallback = await pool.query(
        "SELECT * FROM contents ORDER BY popularity DESC NULLS LAST, created_at DESC LIMIT 30"
      );
      return res.json(fallback.rows);
    }

    const conditions = [];
    const values = [];

    clean.forEach(term => {
      values.push(`%${term}%`);
      conditions.push(`genres ILIKE $${values.length} OR category ILIKE $${values.length} OR country ILIKE $${values.length} OR tags ILIKE $${values.length}`);
    });

    const result = await pool.query(
      `SELECT * FROM contents
       WHERE ${conditions.map(c => `(${c})`).join(" OR ")}
       ORDER BY popularity DESC NULLS LAST, views DESC NULLS LAST, created_at DESC
       LIMIT 40`,
      values
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Recommendation error", details: err.message });
  }
});

/* METADATA */
app.get("/metadata/tmdb", async (req, res) => {
  const response = await axios.get("https://api.themoviedb.org/3/search/multi", {
    params: { api_key: process.env.TMDB_API_KEY, query: req.query.q, language: "ro-RO" },
  });
  res.json(response.data.results);
});

app.get("/metadata/omdb", async (req, res) => {
  const response = await axios.get("https://www.omdbapi.com/", {
    params: { apikey: process.env.OMDB_API_KEY, s: req.query.q },
  });
  res.json(response.data);
});

app.get("/metadata/youtube", async (req, res) => {
  const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
    params: {
      key: process.env.YOUTUBE_API_KEY.trim(),
      q: req.query.q + " trailer",
      part: "snippet",
      type: "video",
      maxResults: 5,
    },
  });
  res.json(response.data.items);
});

app.get("/metadata/anime", async (req, res) => {
  const response = await axios.get("https://api.jikan.moe/v4/anime", {
    params: { q: req.query.q, limit: 10 },
  });
  res.json(response.data.data);
});

app.get("/metadata/tv", async (req, res) => {
  const response = await axios.get("https://api.tvmaze.com/search/shows", {
    params: { q: req.query.q },
  });
  res.json(response.data);
});

app.get("/metadata/korean", async (req, res) => {
  const response = await axios.get("https://api.tvmaze.com/search/shows", {
    params: { q: req.query.q + " korean drama" },
  });
  res.json(response.data);
});

app.get("/metadata/indian", async (req, res) => {
  const response = await axios.get("https://api.tvmaze.com/search/shows", {
    params: { q: req.query.q + " indian" },
  });
  res.json(response.data);
});

app.get("/metadata/telenovela", async (req, res) => {
  const response = await axios.get("https://api.tvmaze.com/search/shows", {
    params: { q: req.query.q + " telenovela" },
  });
  res.json(response.data);
});

app.get("/metadata/music", async (req, res) => {
  const response = await axios.get("https://musicbrainz.org/ws/2/artist", {
    params: { query: req.query.q, fmt: "json", limit: 10 },
    headers: { "User-Agent": "NubiruStream/1.0 (local-dev)" },
  });
  res.json(response.data.artists);
});

app.get("/metadata/sport", async (req, res) => {
  const response = await axios.get("https://www.thesportsdb.com/api/v1/json/3/searchteams.php", {
    params: { t: req.query.q },
  });
  res.json(response.data.teams || []);
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/../public/index.html");
});

initDb().then(() => {
  app.listen(process.env.PORT || 3000, () => {
    console.log("Nubiru Stream ULTRA running on port " + (process.env.PORT || 3000));
  });
});
