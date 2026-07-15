const express = require('express');
const router = express.Router();

module.exports = (pool) => {

  const crud = (table, fields) => {
    router.post(`/${table}`, async (req, res) => {
      const keys = fields.filter(f => req.body[f] !== undefined);
      const values = keys.map(k => req.body[k]);
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      try {
        const result = await pool.query(
          `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
          values
        );
        res.json(result.rows[0]);
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get(`/${table}/:owner_id`, async (req, res) => {
      try {
        const result = await pool.query(`SELECT * FROM ${table} WHERE owner_id = $1`, [req.params.owner_id]);
        res.json(result.rows);
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.put(`/${table}/item/:id`, async (req, res) => {
      const keys = fields.filter(f => req.body[f] !== undefined && f !== 'owner_id');
      const values = keys.map(k => req.body[k]);
      const setClause = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
      try {
        const result = await pool.query(
          `UPDATE ${table} SET ${setClause} WHERE id=$${keys.length + 1} RETURNING *`,
          [...values, req.params.id]
        );
        res.json(result.rows[0]);
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.delete(`/${table}/item/:id`, async (req, res) => {
      try {
        await pool.query(`DELETE FROM ${table} WHERE id=$1`, [req.params.id]);
        res.json({ success: true });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });
  };

  crud('documents', ['owner_id','type','label','issue_date','expiry_date','status','notes']);
  crud('emergency_contacts', ['owner_id','name','relationship','phone','email','is_primary']);
  crud('subscriptions', ['owner_id','name','amount','currency','billing_cycle','next_charge_date','status']);
  crud('vault_entries', ['owner_id','label','encrypted_value']);
  crud('life_events', ['owner_id','type','event_date','notes']);

  return router;
};

// Attach status endpoint separately since it's custom logic, not plain CRUD
module.exports.attachStatus = (app, pool) => {
  app.get('/api/status/:owner_id', async (req, res) => {
    try {
      const docs = await pool.query(
        `SELECT id, type, label, expiry_date FROM documents WHERE owner_id = $1`,
        [req.params.owner_id]
      );

      const today = new Date();
      const in30days = new Date();
      in30days.setDate(today.getDate() + 30);

      const expired = [];
      const expiring_soon = [];
      const ok = [];

      for (const doc of docs.rows) {
        if (!doc.expiry_date) continue;
        const expiry = new Date(doc.expiry_date);
        if (expiry < today) expired.push(doc);
        else if (expiry <= in30days) expiring_soon.push(doc);
        else ok.push(doc);
      }

      res.json({
        owner_id: req.params.owner_id,
        summary: `${expired.length} expired, ${expiring_soon.length} expiring soon, ${ok.length} up to date`,
        expired,
        expiring_soon,
        ok
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};

module.exports.attachVault = (app, pool) => {
  const CryptoJS = require('crypto-js');
  const SECRET = process.env.VAULT_SECRET;

  app.post('/api/vault/secure', async (req, res) => {
    const { owner_id, label, value } = req.body;
    try {
      const encrypted = CryptoJS.AES.encrypt(value, SECRET).toString();
      const result = await pool.query(
        `INSERT INTO vault_entries (owner_id, label, encrypted_value) VALUES ($1, $2, $3) RETURNING id, owner_id, label, created_at`,
        [owner_id, label, encrypted]
      );
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/vault/reveal/:id', async (req, res) => {
    try {
      const result = await pool.query(`SELECT * FROM vault_entries WHERE id = $1`, [req.params.id]);
      if (!result.rows[0]) return res.status(404).json({ error: 'not found' });
      const bytes = CryptoJS.AES.decrypt(result.rows[0].encrypted_value, SECRET);
      const decrypted = bytes.toString(CryptoJS.enc.Utf8);
      res.json({ id: result.rows[0].id, label: result.rows[0].label, value: decrypted });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
};

module.exports.attachPlan = (app, pool) => {
  app.get('/api/plan/:owner_id', async (req, res) => {
    const owner_id = req.params.owner_id;
    try {
      const user = await pool.query(`SELECT name, email FROM users WHERE id = $1`, [owner_id]);
      const docs = await pool.query(`SELECT type, label, expiry_date, status FROM documents WHERE owner_id = $1`, [owner_id]);
      const contacts = await pool.query(`SELECT name, relationship, phone, email, is_primary FROM emergency_contacts WHERE owner_id = $1`, [owner_id]);
      const subs = await pool.query(`SELECT name, amount, currency, billing_cycle FROM subscriptions WHERE owner_id = $1`, [owner_id]);
      const vaultLabels = await pool.query(`SELECT id, label FROM vault_entries WHERE owner_id = $1`, [owner_id]);

      res.json({
        generated_for: user.rows[0] || null,
        instructions: "This plan should be shared with trusted contacts in the event of an emergency.",
        important_documents: docs.rows,
        emergency_contacts: contacts.rows,
        active_subscriptions_to_cancel: subs.rows,
        vault_entries_reference: vaultLabels.rows.map(v => ({
          id: v.id,
          label: v.label,
          note: "Access via /api/vault/reveal/:id — contact requires authorization"
        }))
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
