import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const access = vi.hoisted(() => vi.fn());
const content = vi.hoisted(() => vi.fn());
vi.mock("../field-app/src/lib/api", () => ({ fetchPhotoAccessUrl: access, fetchPhotoContent: content }));
import { SyncedMedia } from "../field-app/src/pages/OpeningDetailPage";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("URL", { createObjectURL: () => "blob:inspection-photo", revokeObjectURL: () => undefined });
  access.mockReset();
  content.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("loads a stored inspection photo from its signed URL and an older inline photo from the content route", async () => {
  access.mockResolvedValue({ url: "https://signed.invalid/photo.jpg", expires_in_seconds: 300 });
  content.mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" }));
  await act(async () => {
    root.render(<>
      <SyncedMedia photo={{ id: "private-photo", storage_url: "private:org/a/opening/b/photo/c.jpg", media_type: "photo" }} label="Inspection event photograph" />
      <SyncedMedia photo={{ id: "inline-photo", storage_url: "inline://inspection/event/holes_breaks", media_type: "photo" }} label="Inspection event photograph" />
    </>);
  });
  const images = host.querySelectorAll("img");
  expect(images[0].getAttribute("src")).toBe("https://signed.invalid/photo.jpg");
  expect(images[1].getAttribute("src")).toBe("blob:inspection-photo");
  expect(content).toHaveBeenCalledWith("inline-photo");
  expect(host.textContent).not.toContain("inline://");
});
