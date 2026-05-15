require('dotenv').config();

const express = require('express');
const dialogflow = require('@google-cloud/dialogflow').v2beta1;
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;

const app = express();
const port = 3000;

// middleware untuk baca body dari Twilio (x-www-form-urlencoded)
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Twilio (kalau nanti butuh kirim outbound terpisah)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
console.log('SID =', accountSid);
console.log('TOKEN OK =', !!authToken);

// Dialogflow config (pakai punyamu)
const projectId = 'chatbot-test-spdy';
const languageCode = 'en-US';
const knowledgeBaseId = 'OTAwNDc5NzY0NjQ2ODAyMjI3Mw';

const sessionClient = new dialogflow.SessionsClient({
  keyFilename: 'C:\\Users\\Faiz Kamaluzaman\\Twilio\\chatbot-test-spdy.json',
});

// fungsi panggil Dialogflow, mirip callGDF kemarin
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
  const messageToSend = responses[0].queryResult.fulfillmentText || '';
  console.log('DF reply:', messageToSend);
  return messageToSend;
}

// webhook dari Twilio
app.post('/reply', async (req, res) => {
  try {
    console.log('From:', req.body.From);
    console.log('Body:', req.body.Body);

    const replyText = await callGDF(req);

    const twiml = new MessagingResponse();
    twiml.message(replyText || 'Maaf, sistem lagi bermasalah. Coba lagi sebentar ya kak.');

    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
  } catch (err) {
    console.error('Error in /reply:', err);
    const twiml = new MessagingResponse();
    twiml.message('Maaf, sistem lagi error. Coba lagi sebentar ya kak.');
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
