"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, zbackroomLoginUrl } from "@/lib/auth";
import { assertUnderRoomLimit } from "@/lib/plan";
import { generateRoomSlug } from "@/lib/token";

const LANGS = new Set(["zh-CN", "en-US", "auto"]);
const UIS = new Set(["zh", "en"]);

function participantInput(form: FormData, slot: "a" | "b") {
  const name = String(form.get(`${slot}Name`) ?? "").trim().slice(0, 32);
  const lang = String(form.get(`${slot}Lang`) ?? "zh-CN");
  const ui = String(form.get(`${slot}Ui`) ?? "zh");
  const font = Number(form.get(`${slot}Font`) ?? 30);
  return {
    slot,
    name: name || (slot === "a" ? "Person A" : "Person B"),
    lang: LANGS.has(lang) ? lang : "zh-CN",
    ui: UIS.has(ui) ? ui : "zh",
    simple: form.get(`${slot}Simple`) === "on",
    font: Number.isFinite(font) && font >= 20 && font <= 60 ? Math.round(font) : 30,
  };
}

// Mirrors ConfirmPO's createPO error handling: validation/limit failures
// become a redirect with ?error=, echoing the typed label back — never a
// bare throw, since this app has no error.tsx boundary and an uncaught
// throw would otherwise crash to Next's generic error page. redirect()'s
// own internal NEXT_REDIRECT throw must stay outside this try/catch.
export async function createRoom(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect(zbackroomLoginUrl("/rooms/new"));

  const label = String(formData.get("label") ?? "").trim().slice(0, 64);

  try {
    await assertUnderRoomLimit(user);
  } catch (err) {
    redirect(`/rooms/new?error=${encodeURIComponent((err as Error).message)}&label=${encodeURIComponent(label)}`);
  }

  const slug = generateRoomSlug();
  const room = await prisma.room.create({
    data: {
      accountId: user.id,
      slug,
      label: label || null,
      participants: {
        create: [participantInput(formData, "a"), participantInput(formData, "b")],
      },
    },
  });

  redirect(`/rooms/${room.id}`);
}

export async function deleteRoom(roomId: string) {
  const user = await getCurrentUser();
  if (!user) redirect(zbackroomLoginUrl("/app"));

  await prisma.room.updateMany({
    where: { id: roomId, accountId: user.id },
    data: { deletedAt: new Date() },
  });

  redirect("/app");
}
