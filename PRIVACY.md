# Data Privacy Policy

Effective date: June 9, 2026

Mirror for Bell's Palsy is designed as a local-first practice companion. The app does not require an account, does not upload camera video, and does not include an application backend for collecting user practice data.

## Live App URLs

- Trial demo: https://mirror-for-bells-palsy.onrender.com/try
- Full practice app: https://mirror-for-bells-palsy.onrender.com/

## What Stays On Your Device

- Camera frames are processed in your browser by the MediaPipe Face Landmarker model.
- Video frames, face landmarks, movement scores, profile baselines, journal entries, and session history are stored locally in your browser storage.
- The app uses IndexedDB under `mirror-db` for app state, sessions, and report images.
- Older local data may be migrated from the legacy `mirror-app-data` localStorage key into IndexedDB.
- The personal recovery model trains locally from sessions already saved on your device and is on by default; optional debug data capture (sampled landmarks and scoring metadata, never raw video) is off by default. Both can be toggled in the app's preferences.
- Optional session reminders use your browser's local notification permission while Mirror is running. Mirror does not send reminder schedules or push subscriptions to a server.

## What Mirror Does Not Collect

- Mirror does not send video, face landmarks, movement profiles, journal entries, or session scores to a Mirror server.
- Mirror does not require login or user accounts.
- This codebase does not include analytics tracking, advertising pixels, or a remote practice-data API.

## Hosting And Third Parties

The public app is hosted on Render. Render may process standard hosting metadata such as IP address, user agent, request path, and timestamps as part of serving the website and operating its infrastructure. Mirror's app code does not use that metadata to build user profiles or collect practice data.

The app loads client-side model/runtime dependencies needed for the browser experience. External links, such as LinkedIn, X, GitHub, or Render, are governed by those services' own privacy policies after you leave Mirror.

## Local Data Control

Because practice data is stored in your browser, clearing site data for the Mirror domain will remove saved sessions, movement profiles, report images, journal entries, and preferences from that browser/device.

## Medical Disclaimer

Mirror is a practice and self-tracking tool. It does not diagnose Bell's palsy, grade facial paralysis, prescribe treatment, or replace professional medical care. Work with a qualified clinician and stop any exercise that causes pain, strain, or discomfort.

## Contact

For questions about privacy or commercial use, contact Ali Mustufa on LinkedIn: https://www.linkedin.com/in/ialimustufa/
