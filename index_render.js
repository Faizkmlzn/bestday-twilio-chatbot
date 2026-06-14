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

  let messageBody = result.fulfillmentText || '';

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
    intentName,
    queryText: result.queryText,
    confidence,
  };
}

// =====================
// CSV LOGGING
// CSV lokal Render tetap mencatat semua percakapan
// =====================
const csvLogFile = path.join(__dirname, 'chatlog.csv');

function initCsvHeader() {
  if (!fs.existsSync(csvLogFile)) {
    fs.writeFileSync(
      csvLogFile,
      'time,userId,userText,botReply,intentName,isConsultationForm\n',
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
    `"${entry.time}","${entry.userId}","${safeUserText}","${safeBotReply}","${safeIntentName}","${entry.isConsultationForm}"\n`;

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
// FILTER FORM KONSULTASI TERISI
// =====================
// FILTER DAN VALIDASI FORM KONSULTASI
// =====================

function getFieldValueFromLines(userText, fieldPatterns) {
  const lines = String(userText || '')
    .split(/\r?\n/)
    .map(line => line.trim());

  for (const line of lines) {
    for (const pattern of fieldPatterns) {
      const match = line.match(pattern);

      if (match) {
        return (match[1] || '').trim();
      }
    }
  }

  return '';
}

function isValueFilled(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[-_]/g, '')
    .trim();

  if (!cleaned) return false;

  const emptyIndicators = [
    'kosong',
    'belum',
    'belum ada',
    'n/a',
    'na',
    'none',
    'tidak ada',
    'opsional',
  ];

  return !emptyIndicators.includes(cleaned.toLowerCase());
}

function isConsultationFormFormat(userText) {
  const text = String(userText || '').toLowerCase();

  return (
    text.includes('nama') &&
    text.includes('tanggal') &&
    text.includes('kebutuhan')
  );
}

function extractConsultationData(userText) {
  const nama = getFieldValueFromLines(userText, [
    /^nama\s*[:：]\s*(.*)$/i,
    /^nama\s+lengkap\s*[:：]\s*(.*)$/i,
  ]);

  const tanggal = getFieldValueFromLines(userText, [
    /^tanggal\s+acara\s*[:：]\s*(.*)$/i,
    /^tgl\s+acara\s*[:：]\s*(.*)$/i,
    /^tanggal\s+nikah\s*[:：]\s*(.*)$/i,
    /^tgl\s+nikah\s*[:：]\s*(.*)$/i,
    /^tanggal\s+wedding\s*[:：]\s*(.*)$/i,
  ]);

  const lokasi = getFieldValueFromLines(userText, [
    /^lokasi\s+acara\s*(?:\(opsional\))?\s*[:：]\s*(.*)$/i,
    /^lokasi\s*(?:\(opsional\))?\s*[:：]\s*(.*)$/i,
  ]);

  const kebutuhan = getFieldValueFromLines(userText, [
    /^kebutuhan\s*[:：]\s*(.*)$/i,
    /^kebutuhan\s+yang\s+di\s*inginkan\s*[:：]\s*(.*)$/i,
    /^kebutuhan\s+yang\s+diinginkan\s*[:：]\s*(.*)$/i,
    /^kebutuhan\s+diinginkan\s*[:：]\s*(.*)$/i,
    /^kebutuhan\s+acara\s*[:：]\s*(.*)$/i,

    // Untuk format pakai tanda tanya:
    // Kebutuhan yang di inginkan? dekorasi
    // Kebutuhan yang di inginkan?
    /^kebutuhan\s+yang\s+di\s*inginkan\s*\?\s*(.*)$/i,
    /^kebutuhan\s+yang\s+diinginkan\s*\?\s*(.*)$/i,
    /^kebutuhan\s*\?\s*(.*)$/i,
  ]);

  return {
    nama,
    tanggal,
    lokasi,
    kebutuhan,
  };
}

function getMissingConsultationFields(data) {
  const missingFields = [];

  if (!isValueFilled(data.nama)) {
    missingFields.push('Nama');
  }

  if (!isValueFilled(data.tanggal)) {
    missingFields.push('Tanggal acara');
  }

  if (!isValueFilled(data.kebutuhan)) {
    missingFields.push('Kebutuhan yang diinginkan');
  }

  // Lokasi tidak dicek karena opsional
  return missingFields;
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

    const timeWIB = getTimeWIB();

    // =====================================================
    // CEK FORMAT FORM KONSULTASI DULU SEBELUM KE DIALOGFLOW
    // =====================================================
    const isFormFormat = isConsultationFormFormat(userText);

    console.log('Terdeteksi format form konsultasi:', isFormFormat ? 'YA' : 'TIDAK');

    if (isFormFormat) {
      const consultationData = extractConsultationData(userText);
      const missingFields = getMissingConsultationFields(consultationData);

      console.log('Data konsultasi terbaca:', consultationData);
      console.log(
        'Data yang kosong:',
        missingFields.length > 0 ? missingFields.join(', ') : 'Tidak ada'
      );

      // =====================================================
      // JIKA FORM KONSULTASI ADA YANG KOSONG
      // =====================================================
      if (missingFields.length > 0) {
        const replyText =
          'Maaf kak, data konsultasinya belum lengkap ya 😊\n\n' +
          'Bagian yang masih perlu dilengkapi:\n' +
          missingFields.map(field => `- ${field}`).join('\n') +
          '\n\n' +
          'Mohon kirim ulang data konsultasi dengan melengkapi bagian yang masih kosong ya kak:\n\n' +
          `Nama : ${consultationData.nama || ''}\n` +
          `Tanggal acara : ${consultationData.tanggal || ''}\n` +
          `Lokasi acara (opsional) : ${consultationData.lokasi || ''}\n` +
          `Kebutuhan yang diinginkan : ${consultationData.kebutuhan || ''}\n\n` +
          '~MinBest';

        saveCsvLog({
          time: timeWIB,
          userId,
          userText,
          botReply: replyText,
          intentName: 'Incomplete Consultation Form',
          isConsultationForm: 'INCOMPLETE',
        });

        console.log('Tidak dicatat ke Google Sheets karena data konsultasi belum lengkap.');

        const twiml = new MessagingResponse();
        twiml.message(replyText);

        res.set('Content-Type', 'text/xml');
        return res.send(twiml.toString());
      }

      // =====================================================
      // JIKA FORM KONSULTASI SUDAH LENGKAP
      // =====================================================
      const replyText =
        'Terima kasih kak, data konsultasinya sudah Bestday terima ya 😊\n\n' +
        'Nanti admin Bestday akan membantu mengecek detail kebutuhan kakak dan menghubungi kakak untuk konsultasi lebih lanjut. See youu 🙌\n' +
        '~MinBest';

      saveCsvLog({
        time: timeWIB,
        userId,
        userText,
        botReply: replyText,
        intentName: 'Filled Consultation Form',
        isConsultationForm: 'YES',
      });

      appendToSheet({
        time: timeWIB,
        userId,
        userText,
        botReply: replyText,
      })
        .then(() => {
          console.log('Berhasil tulis data form konsultasi ke Google Sheets');
        })
        .catch(err => {
          console.error('Error tulis ke Google Sheets:', err.message);
        });

      const twiml = new MessagingResponse();
      twiml.message(replyText);

      res.set('Content-Type', 'text/xml');
      return res.send(twiml.toString());
    }

    // =====================================================
    // KALAU BUKAN FORM, BARU KIRIM KE DIALOGFLOW
    // =====================================================
    const dialogflowResult = await callGDF(req);

    const replyText = dialogflowResult.replyText;
    const intentName = dialogflowResult.intentName;
    const confidence = dialogflowResult.confidence;

    console.log('Intent:', intentName);
    console.log('Confidence:', confidence);

    saveCsvLog({
      time: timeWIB,
      userId,
      userText,
      botReply: replyText || '',
      intentName,
      isConsultationForm: 'NO',
    });

    console.log('Tidak dicatat ke Google Sheets karena bukan form konsultasi.');

    const twiml = new MessagingResponse();

    twiml.message(
      replyText || 'Maaf, sistem lagi bermasalah. Coba lagi sebentar ya kak.'
    );

    res.set('Content-Type', 'text/xml');
    return res.send(twiml.toString());

  } catch (err) {
    console.error('Error in webhook:', err);

    const twiml = new MessagingResponse();
    twiml.message('Maaf, sistem lagi error. Coba lagi sebentar ya kak.');

    res.set('Content-Type', 'text/xml');
    return res.send(twiml.toString());
  }
}


// =====================
// ENDPOINT WEBHOOK
// =====================
app.post('/reply', handleTwilioWebhook);
app.post('/whatsapp', handleTwilioWebhook);

// =====================
// LISTEN SERVER
// =====================
app.listen(PORT, () => {
  console.log(`Bestday Twilio webhook Render listening on port ${PORT}`);
});