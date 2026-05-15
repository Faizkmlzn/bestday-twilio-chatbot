require('dotenv').config();

const fs = require('fs');
const path = require('path');

const express = require('express');
const dialogflow = require('@google-cloud/dialogflow').v2beta1;
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// =====================
// MIDDLEWARE
// =====================
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// =====================
// ENVIRONMENT CONFIG
// =====================
const projectId = process.env.GOOGLE_PROJECT_ID;
const languageCode = process.env.DIALOGFLOW_LANGUAGE_CODE || 'en-US';
const knowledgeBaseId = process.env.DIALOGFLOW_KNOWLEDGE_BASE_ID;

const sheetId = process.env.GOOGLE_SHEET_ID;
const sheetRange = process.env.GOOGLE_SHEET_RANGE || 'ChatLog!A:D';

const googleCredentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

// Debug env penting di Render Logs
console.log('GOOGLE_PROJECT_ID:', projectId || 'BELUM DIISI');
console.log('DIALOGFLOW_LANGUAGE_CODE:', languageCode);
console.log('DIALOGFLOW_KNOWLEDGE_BASE_ID:', knowledgeBaseId || 'TIDAK DIGUNAKAN');
console.log('GOOGLE_SHEET_ID:', sheetId ? 'TERISI' : 'BELUM DIISI');
console.log('GOOGLE_SHEET_RANGE:', sheetRange);
console.log('GOOGLE_APPLICATION_CREDENTIALS:', googleCredentialPath || 'BELUM DIISI');

// =====================
// DIALOGFLOW CLIENT
// =====================
const sessionClient = new dialogflow.SessionsClient({
  keyFilename: googleCredentialPath,
});

// =====================
// ENDPOINT CEK SERVER
// =====================
app.get('/', (req, res) => {
  res.send('Bestday Twilio webhook berjalan di Render.');
});

// =====================
// FUNGSI PANGGIL DIALOGFLOW
// =====================
async function callGDF(req) {
  const userId = req.body.From || 'unknown-user';
  const userText = req.body.Body || '';

  // Gunakan nomor WhatsApp user sebagai session ID
  // supaya percakapan tiap user lebih konsisten.
  const sessionId = String(userId)
    .replace('whatsapp:', '')
    .replace(/[^\w-]/g, '');

  const sessionPath = sessionClient.projectAgentSessionPath(
    projectId,
    sessionId
  );

  const request = {
    session: sessionPath,
    queryInput: {
      text: {
        text: userText,
        languageCode: languageCode,
      },
    },
  };

  // Jika knowledge base dipakai, tambahkan queryParams
  if (knowledgeBaseId) {
    const knowledgeBasePath =
      'projects/' + projectId + '/knowledgeBases/' + knowledgeBaseId;

    request.queryParams = {
      knowledgeBaseNames: [knowledgeBasePath],
    };
  }

  const responses = await sessionClient.detectIntent(request);
  const result = responses[0].queryResult;

  // =====================
  // AMBIL tanggal_nikah DAN POTONG JAM
  // =====================
  let rawTanggalNikah = '';
  let onlyDateNikah = '';

  if (
    result.parameters &&
    result.parameters.fields &&
    result.parameters.fields.tanggal_nikah &&
    result.parameters.fields.tanggal_nikah.stringValue
  ) {
    rawTanggalNikah = result.parameters.fields.tanggal_nikah.stringValue;
    onlyDateNikah = rawTanggalNikah.split('T')[0];
  }

  console.log('>> tanggal_nikah raw:', rawTanggalNikah);
  console.log('>> tanggal_nikah onlyDate:', onlyDateNikah);

  // Jawaban asli dari Dialogflow
  let messageBody = result.fulfillmentText || '';

  // Kalau ada tanggal_nikah, ganti placeholder di text Dialogflow
  if (onlyDateNikah) {
    messageBody = messageBody.replace('{tanggal_nikah}', onlyDateNikah);
  }

  // =====================
  // AMBIL salam_type DARI PARAMETERS
  // =====================
  let salamType = '';

  if (
    result.parameters &&
    result.parameters.fields &&
    result.parameters.fields.salam_type &&
    result.parameters.fields.salam_type.stringValue
  ) {
    salamType = result.parameters.fields.salam_type.stringValue;
  }

  console.log('>> raw parameters:', JSON.stringify(result.parameters));
  console.log('>> salamType parsed:', salamType);

  // =====================
  // FUNGSI PREFIX SALAM
  // =====================
  function buildSalamPrefix(salamType) {
    const s = (salamType || '').toLowerCase();

    if (s.includes('assalamu')) {
      return 'Wa\'alaikumussalam kakak, ';
    }

    switch (s) {
      case 'selamat pagi':
      case 'pagi':
        return 'Selamat pagi kak, ';
      case 'selamat siang':
      case 'siang':
        return 'Selamat siang kak, ';
      case 'selamat sore':
      case 'sore':
        return 'Selamat sore kak, ';
      case 'selamat malam':
      case 'malam':
        return 'Selamat malam kak, ';
      case 'halo':
      case 'hi':
      default:
        return 'Haloo kak, ';
    }
  }

  const prefix = salamType ? buildSalamPrefix(salamType) : '';
  const messageToSend = prefix + messageBody;

  const intentName = result.intent ? result.intent.displayName : 'unknown';
  const confidence = result.intentDetectionConfidence || 0;

  console.log('Query text:', result.queryText);
  console.log('Intent:', intentName);
  console.log('Confidence:', confidence);
  console.log('Final reply:', messageToSend);

  return {
    replyText: messageToSend,
    intentName: intentName,
    queryText: result.queryText,
    confidence: confidence,
  };
}

// =====================
// CSV LOGGING
// =====================
const csvLogFile = path.join(__dirname, 'chatlog.csv');

function initCsvHeader() {
  if (!fs.existsSync(csvLogFile)) {
    fs.writeFileSync(
      csvLogFile,
      'time,userId,userText,botReply,intentName,isLead\n',
      'utf8'
    );
  }
}

function saveCsvLog(entry) {
  initCsvHeader();

  const safeUserText = (entry.userText || '').replace(/"/g, '""');
  const safeBotReply = (entry.botReply || '').replace(/"/g, '""');
  const safeIntentName = (entry.intentName || '').replace(/"/g, '""');

  const line =
    `"${entry.time}","${entry.userId}","${safeUserText}","${safeBotReply}","${safeIntentName}","${entry.isLead}"\n`;

  fs.appendFile(csvLogFile, line, 'utf8', (err) => {
    if (err) {
      console.error('Gagal nulis ke CSV:', err);
    }
  });
}

// =====================
// GOOGLE SHEETS HELPER
// =====================
async function appendToSheet({ time, userId, userText, botReply }) {
  if (!sheetId) {
    console.warn('GOOGLE_SHEET_ID belum diisi. Log ke Google Sheets dilewati.');
    return;
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: googleCredentialPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const authClient = await auth.getClient();

  const sheets = google.sheets({
    version: 'v4',
    auth: authClient,
  });

  const values = [[time, userId, userText, botReply]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: sheetRange,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values,
    },
  });
}

// =====================
// FORMAT WAKTU WIB
// =====================
function getTimeWIB() {
  const now = new Date();

  // Render biasanya UTC, jadi tambah 7 jam untuk WIB
  now.setHours(now.getHours() + 7);

  const pad = n => String(n).padStart(2, '0');

  return (
    now.getFullYear() + '-' +
    pad(now.getMonth() + 1) + '-' +
    pad(now.getDate()) + ' ' +
    pad(now.getHours()) + ':' +
    pad(now.getMinutes()) + ':' +
    pad(now.getSeconds()) + ' WIB'
  );
}

// =====================
// FILTER LEAD KONSULTASI
// =====================
function isSeriousConsultationLead(intentName, userText) {
  const intent = String(intentName || '').toLowerCase();
  const text = String(userText || '').toLowerCase();

  // Deteksi utama dari nama intent Dialogflow
  const intentIndicators = [
    'konsultasi',
    'consultation',
    'admin',
    'hubungi',
    'cs',
    'customer service',
    'human',
    'operator',
    'booking',
    'jadwalkan',
  ];

  if (intentIndicators.some(keyword => intent.includes(keyword))) {
    return true;
  }

  // Deteksi cadangan dari isi chat user
  const textIndicators = [
    'konsultasi',
    'mau konsultasi',
    'ingin konsultasi',
    'saya mau konsultasi',
    'aku mau konsultasi',
    'konsul',
    'admin',
    'hubungi admin',
    'kontak admin',
    'cs',
    'customer service',
    'operator',
    'orang bestday',
    'pihak bestday',
    'tim bestday',
    'mau tanya langsung',
    'tanya langsung',
    'ngobrol langsung',
    'bicara langsung',
    'mau lanjut',
    'ingin lanjut',
    'lanjut booking',
    'mau booking',
    'booking',
    'book',
    'jadwal konsultasi',
    'saya tertarik',
    'aku tertarik',
    'tertarik',
    'mau dibantu',
    'minta dibantu',
    'hubungi saya',
    'kontak saya',
    'bisa dihubungi',
    'mau pakai jasa',
    'mau pakai paket',
    'mau deal',
    'deal',
    'dp',
    'down payment',
    'bayar dp',
    'lanjut dengan bestday',
  ];

  return textIndicators.some(keyword => text.includes(keyword));
}

// =====================
// HANDLER WEBHOOK TWILIO
// =====================
async function handleTwilioWebhook(req, res) {
  try {
    const userId = req.body.From || '';
    const userText = req.body.Body || '';

    console.log('==============================');
    console.log('Webhook Twilio masuk');
    console.log('From:', userId);
    console.log('Body:', userText);

    if (!userText) {
      const twiml = new MessagingResponse();
      twiml.message('Maaf kak, pesannya kosong atau tidak terbaca.');

      res.set('Content-Type', 'text/xml');
      return res.send(twiml.toString());
    }

    const dialogflowResult = await callGDF(req);

    const replyText = dialogflowResult.replyText;
    const intentName = dialogflowResult.intentName;
    const confidence = dialogflowResult.confidence;

    const timeWIB = getTimeWIB();

    const shouldSaveToSheet = isSeriousConsultationLead(intentName, userText);

    console.log('Lead konsultasi:', shouldSaveToSheet ? 'YA' : 'TIDAK');
    console.log('Intent untuk filter lead:', intentName);
    console.log('Confidence untuk filter lead:', confidence);

    // CSV lokal Render tetap mencatat semua percakapan
    saveCsvLog({
      time: timeWIB,
      userId,
      userText,
      botReply: replyText || '',
      intentName,
      isLead: shouldSaveToSheet ? 'YES' : 'NO',
    });

    // Google Sheets hanya mencatat calon klien serius / lead konsultasi
    if (shouldSaveToSheet) {
      appendToSheet({
        time: timeWIB,
        userId,
        userText,
        botReply: replyText || '',
      })
        .then(() => {
          console.log('Berhasil tulis lead konsultasi ke Google Sheets');
        })
        .catch(err => {
          console.error('Error tulis ke Google Sheets:', err.message);
        });
    } else {
      console.log('Tidak dicatat ke Google Sheets karena bukan lead konsultasi.');
    }

    // Balas ke Twilio
    const twiml = new MessagingResponse();

    twiml.message(
      replyText || 'Maaf, sistem lagi bermasalah. Coba lagi sebentar ya kak.'
    );

    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());

  } catch (err) {
    console.error('Error in webhook:', err);

    const twiml = new MessagingResponse();
    twiml.message('Maaf, sistem lagi error. Coba lagi sebentar ya kak.');

    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
  }
}

// =====================
// ENDPOINT WEBHOOK
// =====================

// Endpoint utama sesuai webhook Twilio kamu
app.post('/reply', handleTwilioWebhook);

// Endpoint tambahan jika nanti ingin pakai /whatsapp
app.post('/whatsapp', handleTwilioWebhook);

// =====================
// LISTEN SERVER
// =====================
app.listen(PORT, () => {
  console.log(`Bestday Twilio webhook Render listening on port ${PORT}`);
});