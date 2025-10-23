// server.js - Backend Dashboard pour Render
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Configuration
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'votre_cle_secrete_ici';
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOAD_DIR));

// Créer dossier uploads
fs.mkdir(UPLOAD_DIR, { recursive: true });

// Base de données en mémoire (remplacer par MongoDB en prod)
let detections = [];
let alerts = [];
let stats = {
  totalDetections: 0,
  byCategory: {},
  lastUpdate: null
};

// Stockage de l'URL du stream Raspberry
let raspberryStreamUrl = null;
let streamLastUpdate = null;

// Middleware d'authentification
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  
  next();
};

// ==================== ROUTES API ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Recevoir une détection du Raspberry Pi
app.post('/api/detection', authenticate, async (req, res) => {
  try {
    const { timestamp, image, detections: dets, stats: detStats } = req.body;
    
    // Sauvegarder l'image
    let imagePath = null;
    if (image) {
      const imageBuffer = Buffer.from(image, 'base64');
      const filename = `detect_${Date.now()}.jpg`;
      imagePath = path.join(UPLOAD_DIR, filename);
      
      await fs.writeFile(imagePath, imageBuffer);
      imagePath = `/uploads/${filename}`;
    }
    
    // Créer l'événement de détection
    const detection = {
      id: `det_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(timestamp),
      image: imagePath,
      detections: dets,
      stats: detStats,
      priority: calculatePriority(dets)
    };
    
    // Ajouter aux données
    detections.unshift(detection);
    
    // Limiter à 1000 détections en mémoire
    if (detections.length > 1000) {
      detections = detections.slice(0, 1000);
    }
    
    // Mettre à jour stats
    stats.totalDetections++;
    stats.lastUpdate = new Date();
    
    dets.forEach(d => {
      const cat = d.categorie || 'autres';
      stats.byCategory[cat] = (stats.byCategory[cat] || 0) + 1;
    });
    
    // Créer alerte si nécessaire
    if (detection.priority === 'high') {
      const alert = {
        id: `alert_${Date.now()}`,
        timestamp: new Date(),
        message: `⚠️ Détection prioritaire: ${dets.map(d => d.objet).join(', ')}`,
        detection: detection,
        acknowledged: false
      };
      
      alerts.unshift(alert);
      
      // Limiter les alertes
      if (alerts.length > 100) {
        alerts = alerts.slice(0, 100);
      }
      
      // 🔔 Notification temps réel via WebSocket
      io.emit('new_alert', alert);
    }
    
    // 📡 Diffuser la nouvelle détection
    io.emit('new_detection', detection);
    
    console.log(`✅ Détection reçue: ${dets.map(d => d.objet).join(', ')}`);
    
    res.json({
      success: true,
      message: 'Détection enregistrée',
      id: detection.id
    });
    
  } catch (error) {
    console.error('❌ Erreur réception:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==================== STREAMING VIDEO ====================

// Endpoint pour que le Raspberry envoie son URL Ngrok
app.post('/api/update-stream-url', authenticate, (req, res) => {
  try {
    const { stream_url } = req.body;
    
    if (!stream_url || !stream_url.startsWith('https://')) {
      return res.status(400).json({ error: 'URL invalide' });
    }
    
    raspberryStreamUrl = stream_url;
    streamLastUpdate = new Date();
    
    console.log(`✅ URL stream mise à jour: ${stream_url}`);
    
    // Notifier tous les clients connectés
    io.emit('stream_url_updated', {
      url: stream_url,
      timestamp: streamLastUpdate
    });
    
    res.json({
      success: true,
      message: 'URL stream mise à jour',
      url: stream_url
    });
    
  } catch (error) {
    console.error('❌ Erreur mise à jour stream:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Endpoint pour récupérer l'URL du stream
app.get('/api/stream-url', (req, res) => {
  if (!raspberryStreamUrl) {
    return res.status(404).json({
      error: 'URL stream non disponible',
      message: 'Le Raspberry Pi n\'a pas encore envoyé son URL'
    });
  }
  
  // Vérifier que l'URL n'est pas trop ancienne (> 2 heures)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  if (streamLastUpdate < twoHoursAgo) {
    return res.status(410).json({
      error: 'URL stream expirée',
      message: 'L\'URL Ngrok a peut-être changé',
      last_update: streamLastUpdate
    });
  }
  
  res.json({
    url: raspberryStreamUrl,
    last_update: streamLastUpdate
  });
});

// ==================== ROUTES API ====================

// Récupérer toutes les détections
app.get('/api/detections', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  
  res.json({
    total: detections.length,
    data: detections.slice(offset, offset + limit)
  });
});

// Récupérer une détection spécifique
app.get('/api/detections/:id', (req, res) => {
  const detection = detections.find(d => d.id === req.params.id);
  
  if (!detection) {
    return res.status(404).json({ error: 'Détection non trouvée' });
  }
  
  res.json(detection);
});

// Récupérer les alertes
app.get('/api/alerts', (req, res) => {
  const unacknowledged = req.query.unacknowledged === 'true';
  
  let result = alerts;
  if (unacknowledged) {
    result = alerts.filter(a => !a.acknowledged);
  }
  
  res.json({
    total: result.length,
    data: result
  });
});

// Acquitter une alerte
app.post('/api/alerts/:id/acknowledge', (req, res) => {
  const alert = alerts.find(a => a.id === req.params.id);
  
  if (!alert) {
    return res.status(404).json({ error: 'Alerte non trouvée' });
  }
  
  alert.acknowledged = true;
  
  // Notifier les clients
  io.emit('alert_acknowledged', alert);
  
  res.json({ success: true, alert });
});

// Statistiques globales
app.get('/api/stats', (req, res) => {
  res.json({
    ...stats,
    activeAlerts: alerts.filter(a => !a.acknowledged).length,
    recentDetections: detections.slice(0, 10).length
  });
});

// Supprimer une détection
app.delete('/api/detections/:id', authenticate, async (req, res) => {
  const index = detections.findIndex(d => d.id === req.params.id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Détection non trouvée' });
  }
  
  const detection = detections[index];
  
  // Supprimer l'image si elle existe
  if (detection.image) {
    try {
      await fs.unlink(path.join(__dirname, 'public', detection.image));
    } catch (err) {
      console.error('Erreur suppression image:', err);
    }
  }
  
  detections.splice(index, 1);
  
  res.json({ success: true });
});

// ==================== FONCTIONS UTILITAIRES ====================

function calculatePriority(dets) {
  const priorityClasses = ['person', 'personne', 'cow', 'vache', 'horse', 'cheval'];
  
  const hasPriority = dets.some(d => 
    priorityClasses.includes(d.objet.toLowerCase()) ||
    priorityClasses.includes(d.nom_anglais?.toLowerCase())
  );
  
  return hasPriority ? 'high' : 'normal';
}

// ==================== WebSocket ====================

io.on('connection', (socket) => {
  console.log('📱 Client connecté:', socket.id);
  
  // Envoyer les stats initiales
  socket.emit('initial_stats', stats);
  
  socket.on('disconnect', () => {
    console.log('👋 Client déconnecté:', socket.id);
  });
});

// ==================== DÉMARRAGE ====================

server.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 DASHBOARD AGRICOLE - Serveur démarré');
  console.log('='.repeat(60));
  console.log(`📡 API: http://localhost:${PORT}`);
  console.log(`🔑 API Key: ${API_KEY}`);
  console.log(`📁 Uploads: ${UPLOAD_DIR}`);
  console.log('='.repeat(60) + '\n');
});

// Gestion erreurs
process.on('uncaughtException', (error) => {
  console.error('❌ Erreur non gérée:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise rejetée:', reason);
});
