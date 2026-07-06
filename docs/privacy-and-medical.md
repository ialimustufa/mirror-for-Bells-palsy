# Privacy And Medical Notes

For the public-facing policy, see [Data Privacy Policy](../PRIVACY.md).

## Data And Privacy

- Camera frames are processed in the browser by the MediaPipe model. No video, landmarks, or scores are sent to any server.
- Session records persist exercise scores, timestamps, dose settings, and snapshot counts.
- Session records may include compact pre-calibration setup-quality metrics such as face presence, alignment ratio, frame rate, brightness, and camera-distance proxy.
- Standard assessment summaries are stored locally in app state and keep compact rest/zone metrics plus a source session timestamp.
- Standard assessment summaries may include optional House-Brackmann-inspired, Sunnybrook-style, and eFACE-style self-tracking estimates when at least 80% of standard movement evidence is usable and all required resting metrics are available.
- The Progress preference for scale-inspired estimates hides those optional values from app panels and printable reports, but does not delete saved assessment records or explicit review exports.
- Report images are stored locally in IndexedDB as separate image blobs so past physiotherapy PDFs can be regenerated without bloating session JSON.
- Browser data exports are explicit local files. The full backup is for restore, while the clinician bundle is a separate JSONL review package that may include assessment trends, selected report images, journal notes, quality flags, and frame samples when the user chooses to export it.
- Validation dataset exports are separate opt-in JSONL files. They can include sampled landmarks, blendshapes, pose matrices, scoring metadata, and empty label templates when local data capture was enabled.
- Movement profiles include neutral landmark data, noise floor data, compact setup-quality metrics, and per-exercise baseline metrics.
- Personal recovery models are trained locally from saved session movement progress. They store compact per-exercise trend metrics, not a replacement face model.
- Journal safety prompts are generated locally from the user's own note text and are stored/exported only as part of local app data or an explicit clinician bundle.
- Optional session reminders use the browser Notification API locally while the app is running. Mirror does not create a server-side reminder schedule, Push API subscription, or service-worker push flow.
- Validation status is tracked in `docs/validation-status.json`; clinical-facing scores remain disabled unless reviewed validation coverage and source-hashed calibrated threshold reports are documented there.
- Optional local data capture can store sampled landmarks, blendshapes, pose matrices, and scoring metadata for debugging/future model work. It is off by default and does not store raw video.
- The first saved profile is kept as `initialMovementProfile` for long-term recovery comparison; the current `movementProfile` can be updated through full or partial retakes.
- When the full profile is retaken, the previous profile is kept as a compact history record. Raw neutral landmarks and noise-floor arrays are not duplicated into history.
- When only weak exercise baselines are retaken, those entries are merged into the current profile without archiving or replacing the rest of the baseline.
- App state is persisted locally in IndexedDB under `mirror-db`, with `appState`, `sessions`, `sessionImages`, and optional `sessionFrameSamples` stores.
- The legacy `mirror-app-data` localStorage record is migrated once and removed after a successful migration.
- Legacy image-side movement profiles are migrated locally to user/anatomical side labels; historical session progress that cannot be recomputed is retained but marked as legacy.
- There is no backend service in this codebase.

## Medical Disclaimer

Mirror is designed for guided practice and self-tracking. It can show optional scale-inspired estimates from local practice data, but those estimates are not clinician-assigned clinical grades. Mirror does not diagnose Bell's palsy, prescribe treatment, or replace professional care.

Users should work with a qualified clinician and stop any exercise that causes pain, strain, or discomfort.
