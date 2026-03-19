import { google } from "googleapis";

const ACCOUNTS = (process.env.GOOGLE_IMPERSONATE_ACCOUNTS || "").split(",").map(e => e.trim());

function getAuth(userEmail, scopes) {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    scopes,
    subject: userEmail,
  });
}

export function getCalendarClient(userEmail) {
  const auth = getAuth(userEmail, ["https://www.googleapis.com/auth/calendar.readonly"]);
  return google.calendar({ version: "v3", auth });
}

export function getGmailClient(userEmail) {
  const auth = getAuth(userEmail, ["https://www.googleapis.com/auth/gmail.readonly"]);
  return google.gmail({ version: "v1", auth });
}

export { ACCOUNTS };
