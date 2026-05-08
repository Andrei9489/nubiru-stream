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

async function calculateQualityScore(content) {
  let metadataScore = 0;
  let sourceScore = 0;
  let popularityScore = 0;
  const notes = [];

  if (content.title) metadataScore += 10; else notes.push("missing_title");
  if (content.description) metadataScore += 20; else notes.push("missing_description");
  if (content.poster_url) metadataScore += 20; else notes.push("missing_poster");
  if (content.backdrop_url) metadataScore += 15; else notes.push("missing_backdrop");
  if (content.year) metadataScore += 10; else notes.push("missing_year");
  if (content.genres || content.genre) metadataScore += 10; else notes.push("missing_genres");
  if (content.rating) metadataScore += 5;
  if (content.tmdb_id || content.imdb_id) metadataScore += 10;

  const links = await pool.query(
    "SELECT COUNT(*)::int AS count FROM content_links WHERE content_id=$1",
    [content.id]
  );

  const linkCount = links.rows[0]?.count || 0;
  if (linkCount > 0) sourceScore += 60;
  else notes.push("missing_sources");

  popularityScore = Math.min(100, Number(content.popularity || 0) + Number(content.views || 0));

  const qualityScore = Math.min(
    100,
    Math.round((metadataScore * 0.55) + (sourceScore * 0.30) + (popularityScore * 0.15))
  );

  const saved = await pool.query(
    `INSERT INTO ai_scores
      (content_id, quality_score, metadata_score, source_score, popularity_score, recommendation_score, notes, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (content_id)
     DO UPDATE SET
      quality_score=$2,
      metadata_score=$3,
      source_score=$4,
      popularity_score=$5,
      recommendation_score=$6,
      notes=$7,
      updated_at=NOW()
     RETURNING *`,
    [content.id, qualityScore, metadataScore, sourceScore, popularityScore, qualityScore, notes.join(",")]
  );

  return saved.rows[0];
}



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

    CREATE TABLE IF NOT EXISTS seasons (
      id SERIAL PRIMARY KEY,
      content_id INT REFERENCES contents(id) ON DELETE CASCADE,
      season_number INT NOT NULL,
      title TEXT,
      description TEXT,
      poster_url TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(content_id, season_number)
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id SERIAL PRIMARY KEY,
      content_id INT REFERENCES contents(id) ON DELETE CASCADE,
      season_id INT REFERENCES seasons(id) ON DELETE CASCADE,
      season_number INT DEFAULT 1,
      episode_number INT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      iframe_url TEXT,
      source_url TEXT,
      duration_seconds INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(content_id, season_number, episode_number)
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
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

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

    const result = await pool.query("SELECT * FROM users WHERE email=$1", [email.toLowerCase()]);
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
    const { q, type, category, genre, country, language, actor, director, collection, channel, year, sort } = req.query;

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
       WHERE title ILIKE $1 OR actors ILIKE $1 OR director ILIKE $1 OR genres ILIKE $1 OR collection ILIKE $1
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

/* SEASONS */
app.post("/seasons", async (req, res) => {
  try {
    const b = req.body;

    const result = await pool.query(
      `INSERT INTO seasons
      (content_id, season_number, title, description, poster_url)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (content_id, season_number)
      DO UPDATE SET title=$3, description=$4, poster_url=$5
      RETURNING *`,
      [b.content_id, b.season_number, b.title, b.description, b.poster_url]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Season error", details: err.message });
  }
});

app.get("/seasons/:contentId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM seasons WHERE content_id=$1 ORDER BY season_number ASC",
      [req.params.contentId]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Get seasons error", details: err.message });
  }
});

/* EPISODES */
app.post("/episodes", async (req, res) => {
  try {
    const b = req.body;

    const result = await pool.query(
      `INSERT INTO episodes
      (
        content_id, season_id, season_number, episode_number,
        title, description, iframe_url, source_url, duration_seconds
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (content_id, season_number, episode_number)
      DO UPDATE SET
        season_id=$2,
        title=$5,
        description=$6,
        iframe_url=$7,
        source_url=$8,
        duration_seconds=$9
      RETURNING *`,
      [
        b.content_id,
        b.season_id || null,
        b.season_number || 1,
        b.episode_number,
        b.title,
        b.description,
        b.iframe_url,
        b.source_url,
        b.duration_seconds || 0,
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Episode error", details: err.message });
  }
});

app.get("/episodes/:contentId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM episodes WHERE content_id=$1 ORDER BY season_number ASC, episode_number ASC",
      [req.params.contentId]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Get episodes error", details: err.message });
  }
});

app.get("/episodes/:contentId/:seasonNumber", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM episodes WHERE content_id=$1 AND season_number=$2 ORDER BY episode_number ASC",
      [req.params.contentId, req.params.seasonNumber]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Get season episodes error", details: err.message });
  }
});

app.delete("/episodes/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM episodes WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Delete episode error", details: err.message });
  }
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
     DO UPDATE SET progress_seconds=$3, duration_seconds=$4, completed=$5, updated_at=NOW()
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
     DO UPDATE SET favorite_genres=$2, favorite_categories=$3, favorite_countries=$4, updated_at=NOW()
     RETURNING *`,
    [req.user.id, favorite_genres, favorite_categories, favorite_countries]
  );

  res.json(result.rows[0]);
});

app.get("/recommendations", auth, async (req, res) => {
  try {
    const prefs = await pool.query("SELECT * FROM user_preferences WHERE user_id=$1", [req.user.id]);

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
        if (prefs.rows[0][k]) prefs.rows[0][k].split(",").forEach(x => terms.push(x.trim()));
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


/* AI METADATA SETTINGS */
app.get("/settings/ai-metadata", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT value FROM app_settings WHERE key='ai_metadata_enabled'"
    );
    res.json({ enabled: result.rows[0]?.value === "true" });
  } catch (err) {
    res.status(500).json({ error: "AI setting error", details: err.message });
  }
});

app.post("/settings/ai-metadata", async (req, res) => {
  try {
    const enabled = req.body.enabled === true ? "true" : "false";

    const result = await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('ai_metadata_enabled', $1, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value=$1, updated_at=NOW()
       RETURNING *`,
      [enabled]
    );

    res.json({ enabled: result.rows[0].value === "true" });
  } catch (err) {
    res.status(500).json({ error: "AI setting save error", details: err.message });
  }
});

/* AI METADATA ENGINE */
app.post("/ai/metadata", async (req, res) => {
  try {
    const { title, type } = req.body;

    if (!title) {
      return res.status(400).json({ error: "Title required" });
    }

    const setting = await pool.query(
      "SELECT value FROM app_settings WHERE key='ai_metadata_enabled'"
    );

    const enabled = setting.rows[0]?.value === "true";

    if (!enabled) {
      return res.json({
        enabled: false,
        message: "AI Metadata is OFF. Manual control active.",
        metadata: {}
      });
    }

    let metadata = {
      title,
      type: type || "movie",
      tags: "ai-metadata",
    };

    try {
      const tmdb = await axios.get("https://api.themoviedb.org/3/search/multi", {
        params: {
          api_key: process.env.TMDB_API_KEY,
          query: title,
          language: "ro-RO",
        },
      });

      const item = tmdb.data.results?.[0];

      if (item) {
        metadata.title = item.title || item.name || title;
        metadata.description = item.overview || "";
        metadata.poster_url = item.poster_path
          ? "https://image.tmdb.org/t/p/w500" + item.poster_path
          : "";
        metadata.backdrop_url = item.backdrop_path
          ? "https://image.tmdb.org/t/p/original" + item.backdrop_path
          : "";
        metadata.year = Number((item.release_date || item.first_air_date || "").slice(0, 4)) || null;
        metadata.type = item.media_type === "tv" ? "series" : "movie";
        metadata.category = item.media_type === "tv" ? "Seriale" : "Filme";
        metadata.tmdb_id = String(item.id || "");
        metadata.popularity = Math.round(item.popularity || 0);
        metadata.rating = item.vote_average ? String(item.vote_average) : "";
      }
    } catch (e) {}

    try {
      const yt = await axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: {
          key: process.env.YOUTUBE_API_KEY.trim(),
          q: metadata.title + " official trailer",
          part: "snippet",
          type: "video",
          maxResults: 1,
        },
      });

      const videoId = yt.data.items?.[0]?.id?.videoId;
      if (videoId) {
        metadata.youtube_trailer = "https://www.youtube.com/embed/" + videoId;
        metadata.iframe_url = metadata.iframe_url || metadata.youtube_trailer;
      }
    } catch (e) {}

    res.json({
      enabled: true,
      metadata
    });
  } catch (err) {
    res.status(500).json({ error: "AI metadata error", details: err.message });
  }
});


/* TMDB TV FULL IMPORT */
function tmdbImage(path, size = "w500") {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : "";
}

async function tmdbGet(url, params = {}) {
  const response = await axios.get(url, {
    params: {
      api_key: process.env.TMDB_API_KEY,
      language: "ro-RO",
      ...params,
    },
  });

  return response.data;
}

app.get("/tmdb/tv/:tmdbId/seasons", async (req, res) => {
  try {
    const tvId = req.params.tmdbId;

    const tv = await tmdbGet(`https://api.themoviedb.org/3/tv/${tvId}`);

    const seasons = [];

    for (const season of tv.seasons || []) {
      if (season.season_number === 0) continue;

      const seasonData = await tmdbGet(
        `https://api.themoviedb.org/3/tv/${tvId}/season/${season.season_number}`
      );

      seasons.push({
        season_number: season.season_number,
        title: season.name || `Sezonul ${season.season_number}`,
        description: season.overview || "",
        poster_url: tmdbImage(season.poster_path),
        episodes: (seasonData.episodes || []).map(ep => ({
          episode_number: ep.episode_number,
          title: ep.name || `Episodul ${ep.episode_number}`,
          description: ep.overview || "",
          duration_seconds: ep.runtime ? ep.runtime * 60 : 0,
        })),
      });
    }

    res.json({
      tmdb_id: tv.id,
      title: tv.name,
      description: tv.overview || "",
      poster_url: tmdbImage(tv.poster_path),
      backdrop_url: tmdbImage(tv.backdrop_path, "original"),
      year: tv.first_air_date ? Number(tv.first_air_date.slice(0, 4)) : null,
      rating: tv.vote_average ? String(tv.vote_average) : "",
      category: "Seriale",
      type: "series",
      seasons,
    });
  } catch (err) {
    res.status(500).json({
      error: "TMDB seasons error",
      details: err.response?.data || err.message,
    });
  }
});

app.post("/tmdb/import-tv", async (req, res) => {
  try {
    const { tmdb_id } = req.body;

    if (!tmdb_id) {
      return res.status(400).json({ error: "tmdb_id required" });
    }

    const tv = await tmdbGet(`https://api.themoviedb.org/3/tv/${tmdb_id}`);

    const contentResult = await pool.query(
      `INSERT INTO contents
      (
        title, description, poster_url, backdrop_url, type,
        year, genre, tmdb_id, category, genres, language,
        rating, tags, popularity, is_featured, is_trending
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,false,false)
      RETURNING *`,
      [
        tv.name,
        tv.overview || "",
        tmdbImage(tv.poster_path),
        tmdbImage(tv.backdrop_path, "original"),
        "series",
        tv.first_air_date ? Number(tv.first_air_date.slice(0, 4)) : null,
        (tv.genres || []).map(g => g.name).join(", "),
        String(tv.id),
        "Seriale",
        (tv.genres || []).map(g => g.name).join(", "),
        tv.original_language || "",
        tv.vote_average ? String(tv.vote_average) : "",
        "tmdb,ai-import,series",
        Math.round(tv.popularity || 0),
      ]
    );

    const content = contentResult.rows[0];
    const importedSeasons = [];
    let importedEpisodes = 0;

    for (const season of tv.seasons || []) {
      if (season.season_number === 0) continue;

      const seasonData = await tmdbGet(
        `https://api.themoviedb.org/3/tv/${tmdb_id}/season/${season.season_number}`
      );

      const seasonResult = await pool.query(
        `INSERT INTO seasons
        (content_id, season_number, title, description, poster_url)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (content_id, season_number)
        DO UPDATE SET title=$3, description=$4, poster_url=$5
        RETURNING *`,
        [
          content.id,
          season.season_number,
          season.name || `Sezonul ${season.season_number}`,
          season.overview || "",
          tmdbImage(season.poster_path),
        ]
      );

      const savedSeason = seasonResult.rows[0];
      importedSeasons.push(savedSeason);

      for (const ep of seasonData.episodes || []) {
        await pool.query(
          `INSERT INTO episodes
          (
            content_id, season_id, season_number, episode_number,
            title, description, iframe_url, source_url, duration_seconds
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (content_id, season_number, episode_number)
          DO UPDATE SET
            season_id=$2,
            title=$5,
            description=$6,
            duration_seconds=$9
          RETURNING *`,
          [
            content.id,
            savedSeason.id,
            season.season_number,
            ep.episode_number,
            ep.name || `Episodul ${ep.episode_number}`,
            ep.overview || "",
            "",
            "",
            ep.runtime ? ep.runtime * 60 : 0,
          ]
        );

        importedEpisodes++;
      }
    }

    res.json({
      ok: true,
      content,
      seasons: importedSeasons.length,
      episodes: importedEpisodes,
    });
  } catch (err) {
    res.status(500).json({
      error: "TMDB import error",
      details: err.response?.data || err.message,
    });
  }
});


/* UNIVERSAL CONTENT PARTS */
app.post("/content-parts", async (req, res) => {
  try {
    const b = req.body;

    const result = await pool.query(
      `INSERT INTO content_parts
      (content_id, part_number, title, description, poster_url, duration_seconds)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (content_id, part_number)
      DO UPDATE SET
        title=$3,
        description=$4,
        poster_url=$5,
        duration_seconds=$6
      RETURNING *`,
      [
        b.content_id,
        b.part_number || 1,
        b.title,
        b.description,
        b.poster_url,
        b.duration_seconds || 0,
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Content part error", details: err.message });
  }
});

app.get("/content-parts/:contentId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM content_parts WHERE content_id=$1 ORDER BY part_number ASC",
      [req.params.contentId]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Get content parts error", details: err.message });
  }
});

app.delete("/content-parts/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM content_parts WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Delete content part error", details: err.message });
  }
});

/* UNIVERSAL CONTENT LINKS */
app.post("/content-links", async (req, res) => {
  try {
    const b = req.body;

    const result = await pool.query(
      `INSERT INTO content_links
      (
        content_id, part_id, episode_id, label, url,
        source_type, language, quality, is_primary, is_trailer, sort_order
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *`,
      [
        b.content_id,
        b.part_id || null,
        b.episode_id || null,
        b.label || "",
        b.url,
        b.source_type || "iframe",
        b.language || "",
        b.quality || "",
        b.is_primary || false,
        b.is_trailer || false,
        b.sort_order || 0,
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Content link error", details: err.message });
  }
});

app.get("/content-links/:contentId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM content_links
       WHERE content_id=$1
       ORDER BY is_primary DESC, sort_order ASC, created_at ASC`,
      [req.params.contentId]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Get content links error", details: err.message });
  }
});

app.delete("/content-links/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM content_links WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Delete content link error", details: err.message });
  }
});

app.post("/content-links/bulk", async (req, res) => {
  try {
    const { content_id, links } = req.body;

    if (!content_id || !Array.isArray(links)) {
      return res.status(400).json({ error: "content_id and links array required" });
    }

    const saved = [];

    for (let i = 0; i < links.length; i++) {
      const l = links[i];

      if (!l.url) continue;

      const result = await pool.query(
        `INSERT INTO content_links
        (
          content_id, part_id, episode_id, label, url,
          source_type, language, quality, is_primary, is_trailer, sort_order
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *`,
        [
          content_id,
          l.part_id || null,
          l.episode_id || null,
          l.label || `Sursă ${i + 1}`,
          l.url,
          l.source_type || "iframe",
          l.language || "",
          l.quality || "",
          l.is_primary || i === 0,
          l.is_trailer || false,
          l.sort_order || i,
        ]
      );

      saved.push(result.rows[0]);
    }

    res.json({ ok: true, count: saved.length, links: saved });
  } catch (err) {
    res.status(500).json({ error: "Bulk content links error", details: err.message });
  }
});

app.get("/content-full/:contentId", async (req, res) => {
  try {
    const content = await pool.query(
      "SELECT * FROM contents WHERE id=$1",
      [req.params.contentId]
    );

    if (!content.rows[0]) {
      return res.status(404).json({ error: "Content not found" });
    }

    const parts = await pool.query(
      "SELECT * FROM content_parts WHERE content_id=$1 ORDER BY part_number ASC",
      [req.params.contentId]
    );

    const links = await pool.query(
      "SELECT * FROM content_links WHERE content_id=$1 ORDER BY is_primary DESC, sort_order ASC",
      [req.params.contentId]
    );

    const seasons = await pool.query(
      "SELECT * FROM seasons WHERE content_id=$1 ORDER BY season_number ASC",
      [req.params.contentId]
    );

    const episodes = await pool.query(
      "SELECT * FROM episodes WHERE content_id=$1 ORDER BY season_number ASC, episode_number ASC",
      [req.params.contentId]
    );

    res.json({
      content: content.rows[0],
      parts: parts.rows,
      links: links.rows,
      seasons: seasons.rows,
      episodes: episodes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: "Content full error", details: err.message });
  }
});


/* UNIVERSAL CONTENT GRAPH */
function slugifyText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function upsertNode(nodeType, name, metadata = {}) {
  if (!name) return null;

  const result = await pool.query(
    `INSERT INTO content_nodes (node_type, name, slug, metadata)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (node_type, name)
     DO UPDATE SET metadata = content_nodes.metadata || $4
     RETURNING *`,
    [
      nodeType,
      String(name).trim(),
      slugifyText(name),
      metadata
    ]
  );

  return result.rows[0];
}

async function addRelation(contentId, node, relationType, strength = 1, metadata = {}) {
  if (!node) return null;

  const result = await pool.query(
    `INSERT INTO content_relations
      (from_content_id, node_id, relation_type, strength, metadata)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [
      contentId,
      node.id,
      relationType,
      strength,
      metadata
    ]
  );

  return result.rows[0];
}

async function addAiTag(contentId, tag, tagType = "general", confidence = 1, source = "ai") {
  if (!tag) return null;

  const result = await pool.query(
    `INSERT INTO ai_tags
      (content_id, tag, tag_type, confidence, source)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (content_id, tag)
     DO UPDATE SET confidence=$4, source=$5
     RETURNING *`,
    [
      contentId,
      String(tag).trim(),
      tagType,
      confidence,
      source
    ]
  );

  return result.rows[0];
}


app.post("/graph/build/:contentId", async (req, res) => {
  try {
    const contentResult = await pool.query(
      "SELECT * FROM contents WHERE id=$1",
      [req.params.contentId]
    );

    const content = contentResult.rows[0];
    if (!content) return res.status(404).json({ error: "Content not found" });

    const nodes = [];
    const tags = [];

    const simpleNodes = [
      ["category", content.category, "belongs_to_category", 3],
      ["type", content.type, "has_type", 3],
      ["country", content.country, "from_country", 2],
      ["language", content.language, "has_language", 2],
      ["collection", content.collection, "part_of_collection", 5],
      ["channel", content.channel, "from_channel", 3],
    ];

    for (const [nodeType, name, rel, strength] of simpleNodes) {
      const node = await upsertNode(nodeType, name, {});
      if (node) {
        await addRelation(content.id, node, rel, strength);
        nodes.push(node);
      }
    }

    const genres = String(content.genres || content.genre || "")
      .split(",")
      .map(x => x.trim())
      .filter(Boolean);

    for (const genre of genres) {
      const node = await upsertNode("genre", genre, {});
      await addRelation(content.id, node, "has_genre", 4);
      nodes.push(node);
      tags.push(await addAiTag(content.id, genre, "genre", 0.95, "graph"));
    }

    const actors = String(content.actors || "")
      .split(",")
      .map(x => x.trim())
      .filter(Boolean);

    for (const actor of actors) {
      const node = await upsertNode("person", actor, { role: "actor" });
      await addRelation(content.id, node, "has_actor", 4);
      nodes.push(node);
      tags.push(await addAiTag(content.id, actor, "actor", 0.9, "graph"));
    }

    if (content.director) {
      const node = await upsertNode("person", content.director, { role: "director" });
      await addRelation(content.id, node, "has_director", 5);
      nodes.push(node);
      tags.push(await addAiTag(content.id, content.director, "director", 0.95, "graph"));
    }

    const manualTags = String(content.tags || "")
      .split(",")
      .map(x => x.trim())
      .filter(Boolean);

    for (const tag of manualTags) {
      tags.push(await addAiTag(content.id, tag, "tag", 0.8, "manual"));
    }

    res.json({
      ok: true,
      content_id: content.id,
      nodes: nodes.length,
      tags: tags.filter(Boolean).length
    });
  } catch (err) {
    res.status(500).json({ error: "Graph build error", details: err.message });
  }
});


app.get("/graph/:contentId", async (req, res) => {
  try {
    const content = await pool.query(
      "SELECT * FROM contents WHERE id=$1",
      [req.params.contentId]
    );

    if (!content.rows[0]) {
      return res.status(404).json({ error: "Content not found" });
    }

    const relations = await pool.query(
      `SELECT r.*, n.node_type, n.name, n.slug, n.metadata AS node_metadata
       FROM content_relations r
       JOIN content_nodes n ON n.id = r.node_id
       WHERE r.from_content_id=$1
       ORDER BY r.strength DESC, n.node_type ASC`,
      [req.params.contentId]
    );

    const tags = await pool.query(
      "SELECT * FROM ai_tags WHERE content_id=$1 ORDER BY confidence DESC",
      [req.params.contentId]
    );

    const score = await pool.query(
      "SELECT * FROM ai_scores WHERE content_id=$1",
      [req.params.contentId]
    );

    res.json({
      content: content.rows[0],
      relations: relations.rows,
      tags: tags.rows,
      score: score.rows[0] || null
    });
  } catch (err) {
    res.status(500).json({ error: "Graph fetch error", details: err.message });
  }
});


/* AI QUALITY COMMAND CENTER */
app.get("/ai/quality", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.title, c.category, c.type, c.poster_url,
              s.quality_score, s.metadata_score, s.source_score,
              s.popularity_score, s.notes, s.updated_at
       FROM contents c
       LEFT JOIN ai_scores s ON s.content_id=c.id
       ORDER BY COALESCE(s.quality_score,0) ASC, c.created_at DESC
       LIMIT 200`
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "AI quality error", details: err.message });
  }
});

app.post("/ai/quality/rebuild", async (req, res) => {
  try {
    const contents = await pool.query("SELECT * FROM contents ORDER BY id ASC");
    const scores = [];

    for (const content of contents.rows) {
      scores.push(await calculateQualityScore(content));
    }

    res.json({ ok: true, count: scores.length, scores });
  } catch (err) {
    res.status(500).json({ error: "AI quality rebuild error", details: err.message });
  }
});

app.post("/ai/command", async (req, res) => {
  try {
    const { command } = req.body;

    if (!command) {
      return res.status(400).json({ error: "command required" });
    }

    const saved = await pool.query(
      `INSERT INTO ai_commands (command, status, result, updated_at)
       VALUES ($1,'processing',$2,NOW())
       RETURNING *`,
      [command, {}]
    );

    const cmd = command.toLowerCase();
    let result = { message: "Command saved", actions: [] };

    if (cmd.includes("quality") || cmd.includes("scor") || cmd.includes("verific")) {
      const contents = await pool.query("SELECT * FROM contents ORDER BY id ASC");
      let count = 0;

      for (const content of contents.rows) {
        await calculateQualityScore(content);
        count++;
      }

      result = { message: "Quality rebuilt", count };
    }

    if (cmd.includes("graph") || cmd.includes("nod")) {
      const contents = await pool.query("SELECT id FROM contents ORDER BY id ASC");

      result = {
        message: "Graph build jobs prepared",
        graph_jobs: contents.rows.map(x => x.id)
      };
    }

    const updated = await pool.query(
      `UPDATE ai_commands
       SET status='done', result=$1, updated_at=NOW()
       WHERE id=$2
       RETURNING *`,
      [result, saved.rows[0].id]
    );

    res.json(updated.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "AI command error", details: err.message });
  }
});

app.get("/ai/commands", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM ai_commands ORDER BY created_at DESC LIMIT 100"
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "AI commands error", details: err.message });
  }
});


/* GRAPH ROUTES PART 2 */

/* SMART SOURCE ENGINE MAX */
function detectSourceType(url = "") {
  const u = String(url).toLowerCase();

  if (u.includes("<iframe")) return "iframe";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (u.includes(".m3u8")) return "m3u8";
  if (u.includes(".mp4")) return "mp4";
  if (u.includes(".mp3") || u.includes(".wav") || u.includes(".aac")) return "audio";
  if (u.includes("vimeo.com")) return "vimeo";
  if (u.includes("dailymotion.com")) return "dailymotion";

  return "external";
}

function normalizeSourceUrl(url = "") {
  let raw = String(url || "").trim();

  if (!raw) return "";

  if (raw.includes("<iframe")) {
    const match = raw.match(/src=["']([^"']+)["']/);
    return match ? match[1] : raw;
  }

  try {
    if (raw.includes("youtube.com/watch")) {
      const parsed = new URL(raw);
      const id = parsed.searchParams.get("v");
      return id ? "https://www.youtube.com/embed/" + id : raw;
    }

    if (raw.includes("youtu.be/")) {
      const id = raw.split("youtu.be/")[1].split("?")[0].split("&")[0];
      return id ? "https://www.youtube.com/embed/" + id : raw;
    }

    if (raw.includes("youtube.com/shorts/")) {
      const id = raw.split("/shorts/")[1].split("?")[0].split("&")[0];
      return id ? "https://www.youtube.com/embed/" + id : raw;
    }

    if (raw.includes("vimeo.com/") && !raw.includes("player.vimeo.com")) {
      const id = raw.split("vimeo.com/")[1].split("?")[0];
      return id ? "https://player.vimeo.com/video/" + id : raw;
    }

    if (raw.includes("dailymotion.com/video/")) {
      const id = raw.split("/video/")[1].split("?")[0];
      return id ? "https://www.dailymotion.com/embed/video/" + id : raw;
    }
  } catch (e) {}

  return raw;
}

function sourceCanEmbed(type) {
  return ["iframe", "youtube", "vimeo", "dailymotion"].includes(type);
}

function sourceCanHtml5(type) {
  return ["mp4", "m3u8", "audio"].includes(type);
}

function buildSourceAnalysis(url = "") {
  const detected_type = detectSourceType(url);
  const normalized_url = normalizeSourceUrl(url);
  const normalized_type = detectSourceType(normalized_url);

  return {
    original_url: url,
    normalized_url,
    detected_type,
    source_type: normalized_type,
    can_embed: sourceCanEmbed(normalized_type),
    can_html5: sourceCanHtml5(normalized_type),
    is_youtube: normalized_type === "youtube",
    is_stream: normalized_type === "m3u8",
    is_audio: normalized_type === "audio"
  };
}


app.post("/sources/analyze", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "url required" });
    }

    res.json(buildSourceAnalysis(url));
  } catch (err) {
    res.status(500).json({ error: "Source analyze error", details: err.message });
  }
});

app.post("/content-links/normalize/:id", async (req, res) => {
  try {
    const linkResult = await pool.query(
      "SELECT * FROM content_links WHERE id=$1",
      [req.params.id]
    );

    const link = linkResult.rows[0];

    if (!link) {
      return res.status(404).json({ error: "Link not found" });
    }

    const analysis = buildSourceAnalysis(link.url);

    const updated = await pool.query(
      `UPDATE content_links
       SET url=$1, source_type=$2
       WHERE id=$3
       RETURNING *`,
      [
        analysis.normalized_url,
        analysis.source_type,
        req.params.id
      ]
    );

    res.json({
      ok: true,
      analysis,
      link: updated.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: "Normalize link error", details: err.message });
  }
});

app.get("/content-play/:contentId", async (req, res) => {
  try {
    const content = await pool.query(
      "SELECT * FROM contents WHERE id=$1",
      [req.params.contentId]
    );

    if (!content.rows[0]) {
      return res.status(404).json({ error: "Content not found" });
    }

    const links = await pool.query(
      `SELECT *
       FROM content_links
       WHERE content_id=$1
       ORDER BY is_primary DESC, is_trailer ASC, sort_order ASC, created_at ASC`,
      [req.params.contentId]
    );

    const normalizedLinks = links.rows.map(link => {
      const analysis = buildSourceAnalysis(link.url);

      return {
        ...link,
        normalized_url: analysis.normalized_url,
        detected_type: analysis.source_type,
        can_embed: analysis.can_embed,
        can_html5: analysis.can_html5,
        is_stream: analysis.is_stream,
        is_audio: analysis.is_audio
      };
    });

    const primary =
      normalizedLinks.find(x => x.is_primary && !x.is_trailer) ||
      normalizedLinks.find(x => !x.is_trailer) ||
      normalizedLinks[0] ||
      null;

    const trailer =
      normalizedLinks.find(x => x.is_trailer) ||
      null;

    res.json({
      content: content.rows[0],
      primary,
      trailer,
      sources: normalizedLinks
    });
  } catch (err) {
    res.status(500).json({ error: "Content play error", details: err.message });
  }
});


/* AI SEMANTIC ENGINE */
function splitClean(text = "") {
  return String(text || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

function extractSemanticKeywords(content) {
  const words = [];

  [
    content.title,
    content.description,
    content.genre,
    content.genres,
    content.category,
    content.tags,
    content.collection,
    content.actors,
    content.director,
    content.country,
    content.language
  ].forEach(v => {
    if (!v) return;
    String(v)
      .replace(/[^\p{L}\p{N}\s,.-]/gu, " ")
      .split(/[\s,.-]+/)
      .map(x => x.trim())
      .filter(x => x.length > 3)
      .forEach(x => words.push(x.toLowerCase()));
  });

  return [...new Set(words)].slice(0, 80);
}

function inferEmotions(content, keywords = []) {
  const text = (
    (content.title || "") + " " +
    (content.description || "") + " " +
    (content.genre || "") + " " +
    (content.genres || "") + " " +
    keywords.join(" ")
  ).toLowerCase();

  const emotions = [];

  const rules = [
    ["epic", ["război", "razboi", "battle", "war", "eroi", "hero", "legend", "fantasy"]],
    ["adventure", ["aventuri", "adventure", "călătorie", "calatorie", "quest", "world"]],
    ["dark", ["dark", "crime", "moarte", "death", "horror", "thriller", "demon"]],
    ["emotional", ["dragoste", "love", "familie", "family", "friend", "prieten", "sacrificiu"]],
    ["fun", ["comedy", "comedie", "fun", "kids", "desene"]],
    ["intense", ["action", "actiune", "acţiune", "fight", "luptă", "lupta", "sport"]],
    ["mysterious", ["mystery", "mister", "secret", "detectiv", "unknown"]],
    ["inspirational", ["avatar", "growth", "destin", "hope", "speranță", "speranta"]]
  ];

  for (const [emotion, keys] of rules) {
    if (keys.some(k => text.includes(k))) emotions.push(emotion);
  }

  return [...new Set(emotions)].slice(0, 12);
}

function buildSemanticSummary(content, keywords, emotions) {
  return [
    content.title ? `Title: ${content.title}` : "",
    content.category ? `Category: ${content.category}` : "",
    content.type ? `Type: ${content.type}` : "",
    content.genres || content.genre ? `Genres: ${content.genres || content.genre}` : "",
    emotions.length ? `Emotions: ${emotions.join(", ")}` : "",
    keywords.length ? `Keywords: ${keywords.slice(0, 20).join(", ")}` : ""
  ].filter(Boolean).join(" | ");
}

function semanticOverlapScore(aKeywords = [], bKeywords = [], aEmotions = [], bEmotions = []) {
  const ak = new Set(aKeywords);
  const bk = new Set(bKeywords);
  const ae = new Set(aEmotions);
  const be = new Set(bEmotions);

  let score = 0;

  for (const x of ak) if (bk.has(x)) score += 3;
  for (const x of ae) if (be.has(x)) score += 8;

  return Math.min(100, score);
}


app.post("/ai/semantic/build/:contentId", async (req, res) => {
  try {
    const contentResult = await pool.query(
      "SELECT * FROM contents WHERE id=$1",
      [req.params.contentId]
    );

    const content = contentResult.rows[0];

    if (!content) {
      return res.status(404).json({ error: "Content not found" });
    }

    const keywords = extractSemanticKeywords(content);
    const emotions = inferEmotions(content, keywords);
    const summary = buildSemanticSummary(content, keywords, emotions);

    const aiScore = Math.min(
      100,
      keywords.length + emotions.length * 10 + (content.description ? 20 : 0)
    );

    const embedding = {
      keywords,
      emotions,
      title: content.title,
      category: content.category,
      type: content.type,
      genres: content.genres || content.genre || "",
      year: content.year || null
    };

    const saved = await pool.query(
      `INSERT INTO ai_embeddings
        (content_id, embedding_type, embedding, summary, emotions, keywords, ai_score, updated_at)
       VALUES ($1,'semantic',$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (content_id, embedding_type)
       DO UPDATE SET
        embedding=$2,
        summary=$3,
        emotions=$4,
        keywords=$5,
        ai_score=$6,
        updated_at=NOW()
       RETURNING *`,
      [
        content.id,
        embedding,
        summary,
        emotions.join(","),
        keywords.join(","),
        aiScore
      ]
    );

    for (const keyword of keywords.slice(0, 30)) {
      await pool.query(
        `INSERT INTO ai_semantic_tags
          (content_id, tag, tag_group, weight, source)
         VALUES ($1,$2,'keyword',1,'semantic')
         ON CONFLICT (content_id, tag)
         DO UPDATE SET weight=1, source='semantic'`,
        [content.id, keyword]
      );
    }

    for (const emotion of emotions) {
      await pool.query(
        `INSERT INTO ai_semantic_tags
          (content_id, tag, tag_group, weight, source)
         VALUES ($1,$2,'emotion',5,'semantic')
         ON CONFLICT (content_id, tag)
         DO UPDATE SET weight=5, source='semantic'`,
        [content.id, emotion]
      );
    }

    res.json({
      ok: true,
      content_id: content.id,
      keywords,
      emotions,
      summary,
      ai_score: aiScore,
      embedding: saved.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: "Semantic build error", details: err.message });
  }
});

app.get("/ai/semantic/:contentId", async (req, res) => {
  try {
    const content = await pool.query(
      "SELECT * FROM contents WHERE id=$1",
      [req.params.contentId]
    );

    if (!content.rows[0]) {
      return res.status(404).json({ error: "Content not found" });
    }

    const embedding = await pool.query(
      "SELECT * FROM ai_embeddings WHERE content_id=$1 ORDER BY updated_at DESC",
      [req.params.contentId]
    );

    const tags = await pool.query(
      "SELECT * FROM ai_semantic_tags WHERE content_id=$1 ORDER BY weight DESC, tag ASC",
      [req.params.contentId]
    );

    res.json({
      content: content.rows[0],
      embeddings: embedding.rows,
      semantic_tags: tags.rows
    });
  } catch (err) {
    res.status(500).json({ error: "Semantic fetch error", details: err.message });
  }
});


app.get("/ai/similar/:contentId", async (req, res) => {
  try {
    const base = await pool.query(
      "SELECT * FROM ai_embeddings WHERE content_id=$1 AND embedding_type='semantic'",
      [req.params.contentId]
    );

    if (!base.rows[0]) {
      return res.status(404).json({ error: "Semantic embedding not found. Build it first." });
    }

    const baseEmbedding = base.rows[0].embedding || {};
    const baseKeywords = baseEmbedding.keywords || [];
    const baseEmotions = baseEmbedding.emotions || [];

    const all = await pool.query(
      `SELECT e.*, c.title, c.poster_url, c.category, c.type, c.year
       FROM ai_embeddings e
       JOIN contents c ON c.id=e.content_id
       WHERE e.embedding_type='semantic'
         AND e.content_id <> $1`,
      [req.params.contentId]
    );

    const results = all.rows.map(row => {
      const emb = row.embedding || {};
      const score = semanticOverlapScore(
        baseKeywords,
        emb.keywords || [],
        baseEmotions,
        emb.emotions || []
      );

      return {
        content_id: row.content_id,
        title: row.title,
        poster_url: row.poster_url,
        category: row.category,
        type: row.type,
        year: row.year,
        score,
        emotions: emb.emotions || [],
        keywords: (emb.keywords || []).slice(0, 20),
        reason: score > 0 ? "semantic/emotional overlap" : "low similarity"
      };
    })
    .filter(x => x.score > 0)
    .sort((a,b) => b.score - a.score)
    .slice(0, 30);

    res.json({
      content_id: Number(req.params.contentId),
      similar: results
    });
  } catch (err) {
    res.status(500).json({ error: "Similar AI error", details: err.message });
  }
});

app.post("/ai/semantic/rebuild", async (req, res) => {
  try {
    const contents = await pool.query("SELECT id FROM contents ORDER BY id ASC");
    const built = [];

    for (const c of contents.rows) {
      const response = await pool.query(
        "SELECT * FROM contents WHERE id=$1",
        [c.id]
      );

      const content = response.rows[0];
      const keywords = extractSemanticKeywords(content);
      const emotions = inferEmotions(content, keywords);
      const summary = buildSemanticSummary(content, keywords, emotions);

      const aiScore = Math.min(
        100,
        keywords.length + emotions.length * 10 + (content.description ? 20 : 0)
      );

      const embedding = {
        keywords,
        emotions,
        title: content.title,
        category: content.category,
        type: content.type,
        genres: content.genres || content.genre || "",
        year: content.year || null
      };

      await pool.query(
        `INSERT INTO ai_embeddings
          (content_id, embedding_type, embedding, summary, emotions, keywords, ai_score, updated_at)
         VALUES ($1,'semantic',$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (content_id, embedding_type)
         DO UPDATE SET
          embedding=$2,
          summary=$3,
          emotions=$4,
          keywords=$5,
          ai_score=$6,
          updated_at=NOW()`,
        [
          content.id,
          embedding,
          summary,
          emotions.join(","),
          keywords.join(","),
          aiScore
        ]
      );

      built.push(content.id);
    }

    res.json({
      ok: true,
      count: built.length,
      content_ids: built
    });
  } catch (err) {
    res.status(500).json({ error: "Semantic rebuild error", details: err.message });
  }
});



/* CONTINUE WATCHING REAL */
app.post("/watch-progress", async (req, res) => {
  try {
    const {
      user_id,
      content_id,
      episode_id,
      progress_seconds,
      duration_seconds,
      completed
    } = req.body;

    if (!content_id) {
      return res.status(400).json({ error: "content_id required" });
    }

    const progress = Number(progress_seconds || 0);
    const duration = Number(duration_seconds || 0);
    const isCompleted = completed === true || (duration > 0 && progress / duration >= 0.9);

    const result = await pool.query(
      `INSERT INTO watch_history
        (user_id, content_id, episode_id, progress_seconds, duration_seconds, completed, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (user_id, content_id)
       DO UPDATE SET
        episode_id=$3,
        progress_seconds=$4,
        duration_seconds=$5,
        completed=$6,
        updated_at=NOW()
       RETURNING *`,
      [
        user_id || null,
        content_id,
        episode_id || null,
        progress,
        duration,
        isCompleted
      ]
    );

    res.json({
      ok: true,
      progress: result.rows[0],
      percent: duration ? Math.round((progress / duration) * 100) : 0
    });
  } catch (err) {
    res.status(500).json({ error: "Watch progress error", details: err.message });
  }
});

app.get("/continue-watching", async (req, res) => {
  try {
    const userId = req.query.user_id || null;

    const result = await pool.query(
      `SELECT
        h.*,
        c.title,
        c.poster_url,
        c.backdrop_url,
        c.type,
        c.category,
        c.year,
        e.season_number,
        e.episode_number,
        e.title AS episode_title,
        CASE
          WHEN h.duration_seconds > 0
          THEN ROUND((h.progress_seconds::numeric / h.duration_seconds::numeric) * 100)
          ELSE 0
        END AS percent
       FROM watch_history h
       JOIN contents c ON c.id = h.content_id
       LEFT JOIN episodes e ON e.id = h.episode_id
       WHERE ($1::int IS NULL OR h.user_id=$1)
         AND COALESCE(h.completed,false)=false
       ORDER BY h.updated_at DESC
       LIMIT 50`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Continue watching error", details: err.message });
  }
});

app.get("/resume/:contentId", async (req, res) => {
  try {
    const userId = req.query.user_id || null;

    const result = await pool.query(
      `SELECT *
       FROM watch_history
       WHERE content_id=$1
         AND ($2::int IS NULL OR user_id=$2)
       ORDER BY updated_at DESC
       LIMIT 1`,
      [req.params.contentId, userId]
    );

    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: "Resume error", details: err.message });
  }
});

/* AI NETFLIX HOMEPAGE RAILS */
app.get("/homepage", async (req, res) => {
  try {
    const userId = req.query.user_id || null;

    const continueWatching = await pool.query(
      `SELECT
        h.*,
        c.title,
        c.poster_url,
        c.backdrop_url,
        c.type,
        c.category,
        c.year,
        CASE
          WHEN h.duration_seconds > 0
          THEN ROUND((h.progress_seconds::numeric / h.duration_seconds::numeric) * 100)
          ELSE 0
        END AS percent
       FROM watch_history h
       JOIN contents c ON c.id = h.content_id
       WHERE ($1::int IS NULL OR h.user_id=$1)
         AND COALESCE(h.completed,false)=false
       ORDER BY h.updated_at DESC
       LIMIT 20`,
      [userId]
    );

    const trending = await pool.query(
      `SELECT *
       FROM contents
       ORDER BY COALESCE(popularity,0) DESC, COALESCE(views,0) DESC, created_at DESC
       LIMIT 30`
    );

    const featured = await pool.query(
      `SELECT *
       FROM contents
       WHERE is_featured=true OR is_trending=true
       ORDER BY is_featured DESC, is_trending DESC, created_at DESC
       LIMIT 30`
    );

    const movies = await pool.query(
      `SELECT *
       FROM contents
       WHERE type='movie' OR category ILIKE '%film%'
       ORDER BY created_at DESC
       LIMIT 30`
    );

    const series = await pool.query(
      `SELECT *
       FROM contents
       WHERE type='series' OR category ILIKE '%serial%'
       ORDER BY created_at DESC
       LIMIT 30`
    );

    const aiPicks = await pool.query(
      `SELECT c.*, s.quality_score, s.recommendation_score, s.notes
       FROM contents c
       LEFT JOIN ai_scores s ON s.content_id=c.id
       ORDER BY COALESCE(s.recommendation_score,0) DESC,
                COALESCE(s.quality_score,0) DESC,
                COALESCE(c.popularity,0) DESC
       LIMIT 30`
    );

    const semantic = await pool.query(
      `SELECT c.*, e.ai_score, e.emotions, e.keywords
       FROM contents c
       JOIN ai_embeddings e ON e.content_id=c.id
       WHERE e.embedding_type='semantic'
       ORDER BY e.ai_score DESC, c.created_at DESC
       LIMIT 30`
    );

    res.json({
      continueWatching: continueWatching.rows,
      trending: trending.rows,
      featured: featured.rows,
      movies: movies.rows,
      series: series.rows,
      aiPicks: aiPicks.rows,
      semantic: semantic.rows
    });
  } catch (err) {
    res.status(500).json({ error: "Homepage rails error", details: err.message });
  }
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/../public/index.html");
});

initDb().then(() => {
  app.listen(process.env.PORT || 3000, () => {
    console.log("Nubiru Stream ULTRA + Episodes running on port " + (process.env.PORT || 3000));
  });
});
