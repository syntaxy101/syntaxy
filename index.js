// server.js - Main backend server for Syntaxy

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Create uploads folder if it doesn't exist
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

// File upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
                                   filename: (req, file, cb) => {
                                       const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
                                       cb(null, uniqueName);
                                   }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

// ============================================
// AUTO-MIGRATION: Add settings columns if missing
// ============================================
(async () => {
    try {
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gallery JSONB DEFAULT '{}'`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_ui JSONB DEFAULT '{}'`);
        console.log('Migration check complete');
    } catch (err) {
        console.error('Migration error:', err);
    }
})();

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
}

// ============================================
// AUTH ROUTES
// ============================================

// Register new user
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        if (username.length < 3) {
            return res.status(400).json({ error: 'Username must be at least 3 characters' });
        }

        if (password.length < 4) {
            return res.status(400).json({ error: 'Password must be at least 4 characters' });
        }

        // Check if user exists
        const existingUser = await pool.query(
            'SELECT id FROM users WHERE LOWER(username) = LOWER($1)',
                                              [username]
        );

        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'Username already taken' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user
        const result = await pool.query(
            `INSERT INTO users (username, password, display_name, color, accent, bio, avatar, banner, created_at)
            VALUES ($1, $2, $1, '#58a6ff', '#3fb950', '', '', '', NOW())
            RETURNING id, username, display_name, color, accent, bio, avatar, banner`,
            [username, hashedPassword]
        );

        const user = result.rows[0];

        // Create token
        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, {
            expiresIn: '7d'
        });

        res.json({ user, token });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        const result = await pool.query(
            'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
                                        [username]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'User not found' });
        }

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            return res.status(400).json({ error: 'Incorrect password' });
        }

        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, {
            expiresIn: '7d'
        });

        // Don't send password back
        delete user.password;

        // Ensure gallery/personal_ui are objects
        user.gallery = user.gallery || {};
        user.personal_ui = user.personal_ui || {};

        res.json({ user, token });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get current user
app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, display_name, color, accent, bio, avatar, banner, gallery, personal_ui FROM users WHERE id = $1',
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = result.rows[0];
        user.gallery = user.gallery || {};
        user.personal_ui = user.personal_ui || {};
        res.json(user);
    } catch (err) {
        console.error('Get me error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// USER ROUTES
// ============================================

// Update profile
app.put('/api/users/profile', authenticateToken, async (req, res) => {
    try {
        const { display_name, bio, color, accent, avatar, banner, gallery, personal_ui } = req.body;

        const result = await pool.query(
            `UPDATE users
            SET display_name = COALESCE($1, display_name),
                                        bio = COALESCE($2, bio),
                                        color = COALESCE($3, color),
                                        accent = COALESCE($4, accent),
                                        avatar = COALESCE($5, avatar),
                                        banner = COALESCE($6, banner),
                                        gallery = COALESCE($7, gallery),
                                        personal_ui = COALESCE($8, personal_ui)
                                        WHERE id = $9
                                        RETURNING id, username, display_name, color, accent, bio, avatar, banner, gallery, personal_ui`,
                                        [display_name, bio, color, accent, avatar, banner,
                                         gallery ? JSON.stringify(gallery) : null,
                                         personal_ui ? JSON.stringify(personal_ui) : null,
                                         req.user.id]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update profile error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Save user settings (gallery + personalUI) - lightweight endpoint for frequent saves
app.put('/api/users/settings', authenticateToken, async (req, res) => {
    try {
        const { gallery, personal_ui } = req.body;

        const updates = [];
        const values = [];
        let paramCount = 0;

        if (gallery !== undefined) {
            paramCount++;
            updates.push(`gallery = $${paramCount}`);
            values.push(JSON.stringify(gallery));
        }
        if (personal_ui !== undefined) {
            paramCount++;
            updates.push(`personal_ui = $${paramCount}`);
            values.push(JSON.stringify(personal_ui));
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No settings to update' });
        }

        paramCount++;
        values.push(req.user.id);

        const result = await pool.query(
            `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING id, gallery, personal_ui`,
            values
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update settings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get user settings
app.get('/api/users/settings', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT gallery, personal_ui FROM users WHERE id = $1',
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const settings = result.rows[0];
        settings.gallery = settings.gallery || {};
        settings.personal_ui = settings.personal_ui || {};
        res.json(settings);
    } catch (err) {
        console.error('Get settings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get user by ID
app.get('/api/users/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, display_name, color, accent, bio, avatar, banner, gallery FROM users WHERE id = $1',
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Get user error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get all users (for DMs list)
app.get('/api/users', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, display_name, color, accent, bio, avatar, banner FROM users WHERE id != $1 ORDER BY username',
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Get users error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// SERVER ROUTES
// ============================================

// Get user's servers
app.get('/api/servers', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT s.*, sm.is_admin
            FROM servers s
            JOIN server_members sm ON s.id = sm.server_id
            WHERE sm.user_id = $1
            ORDER BY s.created_at`,
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Get servers error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create server
app.post('/api/servers', authenticateToken, async (req, res) => {
    try {
        const { name, icon, icon_img, accent } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Server name required' });
        }

        // Create server
        const serverResult = await pool.query(
            `INSERT INTO servers (name, icon, icon_img, owner_id, accent, created_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            RETURNING *`,
            [name, icon || name[0], icon_img || '', req.user.id, accent || '#58a6ff']
        );

        const server = serverResult.rows[0];

        // Add owner as admin member
        await pool.query(
            'INSERT INTO server_members (server_id, user_id, is_admin) VALUES ($1, $2, true)',
                         [server.id, req.user.id]
        );

        // Create default channel
        await pool.query(
            `INSERT INTO channels (server_id, name, description, created_at)
            VALUES ($1, 'general', 'Welcome!', NOW())`,
                         [server.id]
        );

        res.json({ ...server, is_admin: true });
    } catch (err) {
        console.error('Create server error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update server
app.put('/api/servers/:id', authenticateToken, async (req, res) => {
    try {
        const { name, icon_img, banner, aesthetics, def_ch_bg } = req.body;

        // Check if user is admin
        const memberCheck = await pool.query(
            'SELECT is_admin FROM server_members WHERE server_id = $1 AND user_id = $2',
            [req.params.id, req.user.id]
        );

        if (memberCheck.rows.length === 0 || !memberCheck.rows[0].is_admin) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const result = await pool.query(
            `UPDATE servers
            SET name = COALESCE($1, name),
                                        icon_img = COALESCE($2, icon_img),
                                        banner = COALESCE($3, banner),
                                        aesthetics = COALESCE($4, aesthetics),
                                        def_ch_bg = COALESCE($5, def_ch_bg)
                                        WHERE id = $6
                                        RETURNING *`,
                                        [name, icon_img, banner, aesthetics ? JSON.stringify(aesthetics) : null, def_ch_bg, req.params.id]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update server error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// CHANNEL ROUTES
// ============================================

// Get channels for a server
app.get('/api/servers/:serverId/channels', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM channels WHERE server_id = $1 ORDER BY created_at',
            [req.params.serverId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Get channels error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create channel
app.post('/api/servers/:serverId/channels', authenticateToken, async (req, res) => {
    try {
        const { name, description } = req.body;

        // Check if user is admin
        const memberCheck = await pool.query(
            'SELECT is_admin FROM server_members WHERE server_id = $1 AND user_id = $2',
            [req.params.serverId, req.user.id]
        );

        if (memberCheck.rows.length === 0 || !memberCheck.rows[0].is_admin) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const result = await pool.query(
            `INSERT INTO channels (server_id, name, description, created_at)
            VALUES ($1, $2, $3, NOW())
            RETURNING *`,
            [req.params.serverId, name.toLowerCase().replace(/\s+/g, '-'), description || '']
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Create channel error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update channel
app.put('/api/channels/:id', authenticateToken, async (req, res) => {
    try {
        const { name, description, background } = req.body;

        const result = await pool.query(
            `UPDATE channels
            SET name = COALESCE($1, name),
                                        description = COALESCE($2, description),
                                        background = COALESCE($3, background)
                                        WHERE id = $4
                                        RETURNING *`,
                                        [name, description, background, req.params.id]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update channel error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete channel
app.delete('/api/channels/:id', authenticateToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM messages WHERE channel_id = $1', [req.params.id]);
        await pool.query('DELETE FROM channels WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete channel error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// MESSAGE ROUTES
// ============================================

// Get messages for a channel
app.get('/api/channels/:channelId/messages', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT m.*, u.username, u.display_name, u.color, u.accent, u.avatar
            FROM messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.channel_id = $1
            ORDER BY m.created_at ASC
            LIMIT 100`,
            [req.params.channelId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Get messages error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Send message
app.post('/api/channels/:channelId/messages', authenticateToken, async (req, res) => {
    try {
        const { text, image, reply_to } = req.body;

        const result = await pool.query(
            `INSERT INTO messages (channel_id, user_id, text, image, reply_to, created_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            RETURNING *`,
            [req.params.channelId, req.user.id, text || '', image || null, reply_to || null]
        );

        // Get full message with user info
        const fullMessage = await pool.query(
            `SELECT m.*, u.username, u.display_name, u.color, u.accent, u.avatar
            FROM messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.id = $1`,
            [result.rows[0].id]
        );

        res.json(fullMessage.rows[0]);
    } catch (err) {
        console.error('Send message error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Edit message
app.put('/api/messages/:id', authenticateToken, async (req, res) => {
    try {
        const { text } = req.body;

        const result = await pool.query(
            `UPDATE messages
            SET text = $1, edited = true
            WHERE id = $2 AND user_id = $3
            RETURNING *`,
            [text, req.params.id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Message not found or not authorized' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Edit message error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete message
app.delete('/api/messages/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'DELETE FROM messages WHERE id = $1 AND user_id = $2 RETURNING id',
            [req.params.id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Message not found or not authorized' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Delete message error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Add reaction
app.post('/api/messages/:id/reactions', authenticateToken, async (req, res) => {
    try {
        const { emoji } = req.body;

        // Get current reactions
        const message = await pool.query('SELECT reactions FROM messages WHERE id = $1', [req.params.id]);

        if (message.rows.length === 0) {
            return res.status(404).json({ error: 'Message not found' });
        }

        let reactions = message.rows[0].reactions || {};

        if (!reactions[emoji]) {
            reactions[emoji] = [];
        }

        if (!reactions[emoji].includes(req.user.id)) {
            reactions[emoji].push(req.user.id);
        } else {
            // Remove reaction if already exists (toggle)
            reactions[emoji] = reactions[emoji].filter(id => id !== req.user.id);
            if (reactions[emoji].length === 0) {
                delete reactions[emoji];
            }
        }

        await pool.query(
            'UPDATE messages SET reactions = $1 WHERE id = $2',
            [JSON.stringify(reactions), req.params.id]
        );

        res.json({ reactions });
    } catch (err) {
        console.error('Add reaction error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// DM ROUTES
// ============================================

// Get or create DM channel between two users
app.post('/api/dms', authenticateToken, async (req, res) => {
    try {
        const { otherUserId } = req.body;

        // Check if DM already exists
        const existing = await pool.query(
            `SELECT * FROM dm_channels
            WHERE (user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1)`,
                                          [req.user.id, otherUserId]
        );

        if (existing.rows.length > 0) {
            return res.json(existing.rows[0]);
        }

        // Create new DM
        const result = await pool.query(
            `INSERT INTO dm_channels (user1_id, user2_id, created_at)
            VALUES ($1, $2, NOW())
            RETURNING *`,
            [req.user.id, otherUserId]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Create DM error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get user's DMs
app.get('/api/dms', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT dc.*,
            u1.username as user1_username, u1.display_name as user1_display_name, u1.avatar as user1_avatar, u1.color as user1_color,
            u2.username as user2_username, u2.display_name as user2_display_name, u2.avatar as user2_avatar, u2.color as user2_color
            FROM dm_channels dc
            JOIN users u1 ON dc.user1_id = u1.id
            JOIN users u2 ON dc.user2_id = u2.id
            WHERE dc.user1_id = $1 OR dc.user2_id = $1
            ORDER BY dc.created_at`,
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Get DMs error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get DM messages
app.get('/api/dms/:dmId/messages', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT m.*, u.username, u.display_name, u.color, u.accent, u.avatar
            FROM dm_messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.dm_channel_id = $1
            ORDER BY m.created_at ASC
            LIMIT 100`,
            [req.params.dmId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Get DM messages error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Send DM message
app.post('/api/dms/:dmId/messages', authenticateToken, async (req, res) => {
    try {
        const { text, image, reply_to } = req.body;

        const result = await pool.query(
            `INSERT INTO dm_messages (dm_channel_id, user_id, text, image, reply_to, created_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            RETURNING *`,
            [req.params.dmId, req.user.id, text || '', image || null, reply_to || null]
        );

        // Get full message with user info
        const fullMessage = await pool.query(
            `SELECT m.*, u.username, u.display_name, u.color, u.accent, u.avatar
            FROM dm_messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.id = $1`,
            [result.rows[0].id]
        );

        res.json(fullMessage.rows[0]);
    } catch (err) {
        console.error('Send DM message error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// FILE UPLOAD ROUTE
// ============================================

app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ url: fileUrl });
});

// SPA catch-all: serve index.html for non-API routes
app.get('/{0,}', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
