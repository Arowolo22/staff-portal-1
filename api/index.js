const app = require('../server.js');

module.exports = (req, res) => {
  // Normalize req.url to guarantee Express routes (/api/...) match reliably
  if (req.url && !req.url.startsWith('/api')) {
    req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
  return app(req, res);
};
