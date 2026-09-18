import type { RoomParticipant } from "@prisma/client";

function callServerUrl(): string {
  return process.env.CALL_SERVER_URL || "http://localhost:8080";
}

// Builds a participant's shareable call link against the separately
// deployed call server (WebRTC signaling + captions — see
// stt_videocall/README.md). This is the exact `room`/`name`/`lang`/`ui`/
// `simple`/`font` query-param contract that server already documents and
// parses — this app only ever needs to build URLs in that shape, never
// change it.
export function buildCallLink(slug: string, participant: RoomParticipant): string {
  const params = new URLSearchParams({
    room: slug,
    name: participant.name,
    lang: participant.lang,
    ui: participant.ui,
  });
  if (participant.simple) params.set("simple", "1");
  if (participant.font && participant.font !== 30) params.set("font", String(participant.font));
  return `${callServerUrl()}/?${params.toString()}`;
}
