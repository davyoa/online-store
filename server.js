import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const isProduction = (process.env.APP_ENV || process.env.NODE_ENV || 'development').toLowerCase() === 'production';
const PORT = Number(process.env.APP_PORT || process.env.PORT || 5000);

const databaseConfig = {
  host: isProduction ? process.env.PROD_DB_HOST || process.env.DB_HOST || 'localhost' : process.env.DEV_DB_HOST || process.env.DB_HOST || 'localhost',
  port: Number(isProduction ? process.env.PROD_DB_PORT || process.env.DB_PORT || 3306 : process.env.DEV_DB_PORT || process.env.DB_PORT || 3306),
  user: isProduction ? process.env.PROD_DB_USER || process.env.DB_USER || 'root' : process.env.DEV_DB_USER || process.env.DB_USER || 'root',
  password: isProduction ? process.env.PROD_DB_PASSWORD || process.env.DB_PASSWORD || '' : process.env.DEV_DB_PASSWORD || process.env.DB_PASSWORD || '',
  database: isProduction ? process.env.PROD_DB_NAME || process.env.DB_NAME || 'swiftshop' : process.env.DEV_DB_NAME || process.env.DB_NAME || 'swiftshop',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  ssl: String(isProduction ? process.env.PROD_DB_SSL ?? process.env.DB_SSL ?? 'false' : process.env.DEV_DB_SSL ?? process.env.DB_SSL ?? 'false').toLowerCase() === 'true'
    ? { rejectUnauthorized: false }
    : undefined
};

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname, { index: false }));

const pool = mysql.createPool(databaseConfig);
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
  if (!storedPassword) return false;
  if (typeof storedPassword === 'string' && !storedPassword.includes(':')) {
    return storedPassword === String(password);
  }

  const [salt, hash] = String(storedPassword).split(':');
  if (!salt || !hash) {
    return storedPassword === String(password);
  }

  try {
    const derived = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
  } catch (error) {
    return false;
  }
}

async function initializeDatabase() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = await fs.readFile(schemaPath, 'utf8');
  const bootstrapConnection = await mysql.createConnection(databaseConfig);

  try {
    const statements = schemaSql
      .replace(/^\s*--.*$/gm, '')
      .split(/;\s*(?:\r?\n|$)/)
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      try {
        await bootstrapConnection.query(statement);
      } catch (error) {
        if (error.code !== 'ER_DUP_KEYNAME' && error.code !== 'ER_DUP_ENTRY') {
          throw error;
        }
      }
    }

    const [passwordColumn] = await bootstrapConnection.query("SHOW COLUMNS FROM users LIKE 'password'");
    if (passwordColumn.length === 0) {
      await bootstrapConnection.query("ALTER TABLE users ADD COLUMN password VARCHAR(255) NULL AFTER email");
    }

    const demoUsers = [
      { name: 'Admin User', email: 'admin@swiftshop.com', password: 'admin123', role: 'admin' },
      { name: 'Client User', email: 'client@swiftshop.com', password: 'password123', role: 'client' }
    ];

    for (const user of demoUsers) {
      const [existing] = await bootstrapConnection.query('SELECT id, password FROM users WHERE email = ? LIMIT 1', [normalizeEmail(user.email)]);
      if (existing.length === 0) {
        await bootstrapConnection.query(
          'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
          [user.name, normalizeEmail(user.email), hashPassword(user.password), user.role]
        );
      } else if (!existing[0].password) {
        await bootstrapConnection.query('UPDATE users SET password = ?, role = ? WHERE id = ?', [hashPassword(user.password), user.role, existing[0].id]);
      }
    }

    console.log('SwiftShop database initialized and seeded.');
  } finally {
    await bootstrapConnection.end();
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/store', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const trimmedName = String(name || '').trim();
    const trimmedEmail = normalizeEmail(email);
    const trimmedPassword = String(password || '').trim();

    if (!trimmedName || !trimmedEmail || !trimmedPassword) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    if (trimmedPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    if (!trimmedEmail.includes('@')) {
      return res.status(400).json({ error: 'Please use a valid email address' });
    }

    const [existingUsers] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [trimmedEmail]);
    if (existingUsers.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const [result] = await pool.query(
      'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
      [trimmedName, trimmedEmail, hashPassword(trimmedPassword), 'client']
    );

    const [rows] = await pool.query('SELECT id, name, email, role, created_at FROM users WHERE id = ?', [result.insertId]);
    res.status(201).json({ user: rows[0] });
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const [rows] = await pool.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = rows[0];
    if (!verifyPassword(password, user.password)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        created_at: user.created_at
      }
    });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, email, role, created_at FROM users ORDER BY id ASC');
    res.json(rows);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM products ORDER BY id DESC');
    res.json(rows);
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const { title, price, category, image, description } = req.body;
    const numericPrice = Number(price);

    if (!String(title || '').trim() || !Number.isFinite(numericPrice) || numericPrice < 0) {
      return res.status(400).json({ error: 'Title and price are required' });
    }

    const [result] = await pool.query(
      'INSERT INTO products (title, price, category, image, description) VALUES (?, ?, ?, ?, ?)',
      [String(title).trim(), numericPrice, category || null, image || null, description || null]
    );

    const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query('DELETE FROM products WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        o.id,
        o.user_id,
        o.total_amount,
        o.status,
        o.created_at,
        u.name AS name,
        u.email AS email
      FROM orders o
      JOIN users u ON o.user_id = u.id
      ORDER BY o.id DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.post('/api/orders', async (req, res) => {
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const { name, email, items } = req.body;

    if (!name || !email || !Array.isArray(items) || items.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Name, email, and a non-empty items array are required' });
    }

    const normalizedItems = items.map((item) => ({
      id: Number(item.id),
      price: Number(item.price),
      qty: Number(item.qty)
    }));

    for (const item of normalizedItems) {
      if (!Number.isInteger(item.id) || item.id <= 0 || !Number.isFinite(item.price) || item.price < 0 || !Number.isInteger(item.qty) || item.qty <= 0) {
        await connection.rollback();
        return res.status(400).json({ error: 'Each item requires id, price, and a positive qty' });
      }
    }

    const total = normalizedItems.reduce((sum, item) => sum + item.price * item.qty, 0);
    const normalizedEmail = normalizeEmail(email);

    let [existingUsers] = await connection.query('SELECT id FROM users WHERE email = ? LIMIT 1', [normalizedEmail]);

    let userId;
    if (existingUsers.length > 0) {
      userId = existingUsers[0].id;
    } else {
      const [userResult] = await connection.query(
        'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
        [String(name).trim(), normalizedEmail, hashPassword('guest-password'), 'client']
      );
      userId = userResult.insertId;
    }

    const [orderResult] = await connection.query(
      'INSERT INTO orders (user_id, total_amount, status) VALUES (?, ?, ?)',
      [userId, total.toFixed(2), 'pending']
    );

    const orderId = orderResult.insertId;
    const itemRows = normalizedItems.map((item) => [orderId, item.id, item.qty, Number(item.price).toFixed(2)]);

    await connection.query('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ?', [itemRows]);
    await connection.commit();

    res.status(201).json({
      orderId,
      status: 'success',
      total: Number(total.toFixed(2))
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Failed to create order' });
  } finally {
    connection?.release();
  }
});

async function startServer() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`SwiftShop server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('SwiftShop startup failed. Check MySQL credentials and availability.', error);
    await pool.end();
    process.exitCode = 1;
  }
}

startServer();

export default app;
