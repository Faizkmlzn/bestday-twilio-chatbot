require('dotenv').config();

const fs = require('fs');
const path = require('path');

const express = require('express');
const dialogflow = require('@google-cloud/dialogflow').v2beta1;
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { MessagingResponse } = require('twilio').twiml;
const { google } = require('googleapis');


const app = express();
const port = 3000;

// middleware untuk baca body dari Twilio (x-www-form-urlencoded)
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Twilio (kalau nanti butuh kirim outbound terpisah)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
console.log('SID =', accountSid);
console.log('TOKEN OK =', !!authToken);

const client = twilio(accountSid, authToken);

// Dialogflow config 
const projectId = 'chatbot-test-spdy';
const languageCode = 'en-US';
const knowledgeBaseId = 'OTAwNDc5NzY0NjQ2ODAyMjI3Mw';

const sessionClient = new dialogflow.SessionsClient({
	keyFilename: 'C:\\Users\\Faiz Kamaluzaman\\Twilio\\chatbot-test-spdy.json',
});

// fungsi panggil Dialogflow CallGDF
	async function callGDF(req) {
	const sessionId = Math.floor(Math.random() * 37);
	const sessionPath = sessionClient.projectAgentSessionPath(
		projectId,
		sessionId
	);
	const knowledgeBasePath =
		'projects/' + projectId + '/knowledgeBases/' + knowledgeBaseId;

	const request = {
		session: sessionPath,
		queryInput: {
		text: {
			text: req.body.Body,       // teks dari WhatsApp
			languageCode: languageCode,
		},
		},
		queryParams: {
		knowledgeBaseNames: [knowledgeBasePath],
		},
		headers: {
		'content-type': 'application/json; charset=utf-8',
		},
	};

	const responses = await sessionClient.detectIntent(request);
	const result = responses[0].queryResult;

	// --- AMBIL tanggal_nikah DAN POTONG JAM ---
	let rawTanggalNikah = '';
	let onlyDateNikah = '';

	if (
	result.parameters &&
	result.parameters.fields &&
	result.parameters.fields.tanggal_nikah &&
	result.parameters.fields.tanggal_nikah.stringValue
	) {
	rawTanggalNikah = result.parameters.fields.tanggal_nikah.stringValue;
	// contoh raw: "2026-07-12T00:00:00+07:00"
	onlyDateNikah = rawTanggalNikah.split('T')[0]; // hasil: "2026-07-12"
	}
	console.log('>> tanggal_nikah raw:', rawTanggalNikah);
	console.log('>> tanggal_nikah onlyDate:', onlyDateNikah);


	// Jawaban asli dari Dialogflow
	let messageBody = result.fulfillmentText || '';
	// kalau ada tanggal_nikah, ganti placeholder di text DF (kalau ada)
	if (onlyDateNikah) {
	// misal di Dialogflow kamu tulis {tanggal_nikah} di response
	messageBody = messageBody.replace('{tanggal_nikah}', onlyDateNikah);
	}
	// --- AMBIL salam_type DARI PARAMETERS.FIELDS ---
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
	// Fungsi bikin prefix salam
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
	// Hanya tambahkan prefix jika ada salam
	const prefix = salamType ? buildSalamPrefix(salamType) : '';
	const messageToSend = prefix + messageBody;

	console.log('Final reply:', messageToSend);
	return messageToSend;
	}

	const csvLogFile = path.join(__dirname, 'chatlog.csv');

	function initCsvHeader() {
	if (!fs.existsSync(csvLogFile)) {
		fs.writeFileSync(
		csvLogFile,
		'time,userId,userText,botReply\n',
		'utf8'
		);
	}
	}

	function saveCsvLog(entry) {
	initCsvHeader();
	const safeUserText = (entry.userText || '').replace(/"/g, '""');
	const safeBotReply = (entry.botReply || '').replace(/"/g, '""');

	const line =
		`"${entry.time}","${entry.userId}","${safeUserText}","${safeBotReply}"\n`;

	fs.appendFile(csvLogFile, line, 'utf8', (err) => {
		if (err) {
		console.error('Gagal nulis ke CSV:', err);
		}
	});
	}

// ==== GOOGLE SHEETS HELPER ====
const SHEET_ID = '1gA0D2X0gy_hRr4lRyl5VncGUjPKovbJR6k_tVrF8msA';
const SHEET_RANGE = 'ChatLog!A:D';

async function appendToSheet({ time, userId, userText, botReply }) {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'chatbot-test-spdy-a4412a19ef98.json', //  nama file JSON
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const values = [[time, userId, userText, botReply]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}
// ==== END GOOGLE SHEETS HELPER ====

// webhook dari Twilio
app.post('/reply', async (req, res) => {
  try {
    const userId = req.body.From; // format: whatsapp:+62...
    const userText = req.body.Body || '';
    console.log('From:', userId);
    console.log('Body:', userText);

    const replyText = await callGDF(req);
    console.log('RAW DF replyText:', JSON.stringify(replyText));

    const now = new Date();
    now.setHours(now.getHours() + 7); // WIB

    const pad = n => String(n).padStart(2, '0');
    const timeWIB =
      now.getFullYear() + '-' +
      pad(now.getMonth() + 1) + '-' +
      pad(now.getDate()) + ' ' +
      pad(now.getHours()) + ':' +
      pad(now.getMinutes()) + ':' +
      pad(now.getSeconds()) + ' WIB';

    // simpan ke CSV
    saveCsvLog({
      time: timeWIB,
      userId,
      userText,
      botReply: replyText || '',
    });

	// simpan ke Google Sheets
	appendToSheet({
	time: timeWIB,
	userId,
	userText,
	botReply: replyText || '',
	}).catch(err => console.error('Error tulis ke Sheet:', err));

    // 4. BALAS WEBHOOK KE TWILIO CEPAT (tanpa isi pesan)
const delayMs = 5000 + Math.floor(Math.random() * 5000); // 5–10 detik
    console.log('Will send reply after', delayMs, 'ms');

    setTimeout(() => {
      const twiml = new MessagingResponse();
      twiml.message(
        replyText || 'Maaf, sistem lagi bermasalah. Coba lagi sebentar ya kak.'
      );
      res.set('Content-Type', 'text/xml');
      res.send(twiml.toString());
    }, delayMs);

  } catch (err) {
    console.error('Error in /reply:', err);
    const twiml = new MessagingResponse();
    twiml.message('Maaf, sistem lagi error. Coba lagi sebentar ya kak.');
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
  }
});

// =====================
// LISTEN SERVER
// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bestday Twilio webhook listening on port ${PORT}`);
});

