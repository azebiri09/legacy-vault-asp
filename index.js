require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/', (req, res) => {
  res.json({ status: 'Legacy Vault ASP running' });
});

const routesModule = require('./routes.js');
app.use('/api', routesModule(pool));
routesModule.attachStatus(app, pool);
routesModule.attachVault(app, pool);
routesModule.attachPlan(app, pool);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
