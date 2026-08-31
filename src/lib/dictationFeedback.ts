import { getFirestore, doc, setDoc } from "firebase/firestore";
import { app as firebaseApp, auth } from "./firebase";
import packageJson from "../../package.json";

/**
 * "This transcription was wrong" feedback from the Dictation history page.
 *
 * Written STRAIGHT to Firestore rather than through a backend route, which is
 * the same thing the Flutter app's `AppFeedbackService` does for this exact
 * collection. Two reasons it has to be this way:
 *
 * - There is no generic feedback endpoint to call. `POST /feedback/alarm-interest`
 *   is hardcoded to one closed list of alarm slugs and builds its report
 *   server-side, and the backend-written `observed_feedback` collection has a
 *   closed document shape with no field for a transcript.
 * - juno-backend deploys independently of this repo, so a route added here
 *   would not be live until someone separately deployed it. Writing directly
 *   keeps this feature shippable from this repo alone.
 *
 * `firestore.rules` already allows a create on `user_feedback` when the
 * document's `uid` matches the caller, and the collection is never
 * client-readable, so this needs no rules change either.
 */

const COLLECTION = "user_feedback";

export interface DictationFeedbackInput {
  /** What the user typed. The only free-form field. */
  message: string;
  /** The transcript being reported. Included deliberately; the dialog says so. */
  transcript: string;
  /** The pre-polish transcript, when AI polish changed the text. Lets a report
   * about the formatting step carry what the user actually said. */
  rawTranscript?: string;
  dictationId: string;
  recordedAtMs: number;
  durationMs: number;
  wordCount: number;
}

/**
 * Sends one report. Audio is NEVER uploaded, only the text - the clip stays
 * encrypted on this machine.
 */
export async function sendDictationFeedback(input: DictationFeedbackInput): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw new Error("No signed-in user");

  const nowMs = Date.now();
  // Same id shape the Flutter client uses, so both surfaces sort together.
  const id = `${nowMs}_${user.uid}`;
  await setDoc(doc(getFirestore(firebaseApp), COLLECTION, id), {
    uid: user.uid,
    text: input.message.trim(),
    category: "dictation_accuracy",
    created_at: new Date(nowMs).toISOString(),
    app_version: packageJson.version,
    // The Flutter writer only ever emits ios/android, so this value is new.
    platform: "windows",
    source: "dictation_history",
    transcript: input.transcript,
    // Spread rather than a bare field: Firestore rejects undefined values.
    ...(input.rawTranscript ? { raw_transcript: input.rawTranscript } : {}),
    dictation_id: input.dictationId,
    recorded_at_ms: input.recordedAtMs,
    duration_ms: input.durationMs,
    word_count: input.wordCount,
  });
}
