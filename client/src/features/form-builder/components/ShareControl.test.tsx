// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublishResult } from "../api/forms.api.ts";
import type { FormSchema } from "../types/form-builder.types.ts";
import {
  addField,
  createEmptyFormSchema,
  createFieldDefinition,
} from "../utils/form-schema.utils.ts";
import { FormBuilder } from "./FormBuilder.tsx";
import {
  SHARE_COPY_FAILED_MESSAGE,
  SHARE_LOAD_FAILED_MESSAGE,
  SHARE_NO_LINK_MESSAGE,
  ShareControl,
} from "./ShareControl.tsx";

const FORM_ID = "665f1c2e8f1b2c3d4e5f6a7b";
const PUBLIC_ID = "Ab3_-Zy9Xw8Vu7Ts6Rq5Pn4M";

afterEach(cleanup);

const expectedUrl = `${window.location.origin}/f/${PUBLIC_ID}`;

const shareButton = () => screen.getByRole("button", { name: "Share" });

const handlers = () => ({
  loadPublicId: vi.fn<(id: string) => Promise<string | null>>(() =>
    Promise.resolve(PUBLIC_ID),
  ),
  copyText: vi.fn<(text: string) => Promise<void>>(() => Promise.resolve()),
  openUrl: vi.fn<(url: string) => void>(),
});

const mount = (
  props: { published?: boolean; formId?: string | undefined } = {},
  h = handlers(),
) => {
  render(
    <ShareControl
      formId={"formId" in props ? props.formId : FORM_ID}
      published={props.published ?? true}
      {...h}
    />,
  );
  return { ...h, user: userEvent.setup() };
};

describe("ShareControl", () => {
  it("is not offered before the form is published", () => {
    const { loadPublicId } = mount({ published: false });

    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(loadPublicId).not.toHaveBeenCalled();
  });

  it("is not offered for a builder with no saved form", () => {
    mount({ formId: undefined });
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });

  it("is offered once published, and opens a Share Form dialog", async () => {
    const { user } = mount();

    await user.click(shareButton());

    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("heading", { name: "Share Form" })).toBeTruthy();
  });

  it("shows the public URL built from the publicId, never the form id", async () => {
    const { loadPublicId, user } = mount();

    await user.click(shareButton());

    const input = (await screen.findByLabelText("Public URL")) as HTMLInputElement;
    expect(input.value).toBe(expectedUrl);
    expect(input.readOnly).toBe(true);
    expect(input.value).not.toContain(FORM_ID);
    expect(loadPublicId).toHaveBeenCalledWith(FORM_ID);
  });

  it("copies the link and shows Copied!", async () => {
    const { copyText, user } = mount();
    await user.click(shareButton());
    await screen.findByLabelText("Public URL");

    await user.click(screen.getByRole("button", { name: "Copy Link" }));

    expect(copyText).toHaveBeenCalledWith(expectedUrl);
    expect(await screen.findByRole("button", { name: "Copied!" })).toBeTruthy();
  });

  it("tells the user to copy by hand when the clipboard is unavailable", async () => {
    const h = handlers();
    h.copyText.mockRejectedValue(new Error("denied"));
    const { user } = mount({}, h);
    await user.click(shareButton());
    await screen.findByLabelText("Public URL");

    await user.click(screen.getByRole("button", { name: "Copy Link" }));

    expect((await screen.findByRole("alert")).textContent).toBe(SHARE_COPY_FAILED_MESSAGE);
    expect(screen.getByRole("button", { name: "Copy Link" })).toBeTruthy();
  });

  it("opens the form in a new tab with Open Form", async () => {
    const { openUrl, user } = mount();
    await user.click(shareButton());
    await screen.findByLabelText("Public URL");

    await user.click(screen.getByRole("button", { name: "Open Form" }));

    expect(openUrl).toHaveBeenCalledWith(expectedUrl);
  });

  it("explains that anyone with the link can respond", async () => {
    const { user } = mount();
    await user.click(shareButton());

    expect(await screen.findByText(/Anyone with this link can respond/i)).toBeTruthy();
  });

  it("shows a safe error and can retry when the link cannot be loaded", async () => {
    const h = handlers();
    h.loadPublicId
      .mockRejectedValueOnce(new Error("stack trace /srv/secret.js"))
      .mockResolvedValue(PUBLIC_ID);
    const { user } = mount({}, h);

    await user.click(shareButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(SHARE_LOAD_FAILED_MESSAGE);
    expect(alert.textContent).not.toContain("secret.js");
    expect(screen.queryByRole("button", { name: "Copy Link" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(((await screen.findByLabelText("Public URL")) as HTMLInputElement).value).toBe(
      expectedUrl,
    );
  });

  it("explains when the server has no public link for the form", async () => {
    const h = handlers();
    h.loadPublicId.mockResolvedValue(null);
    const { user } = mount({}, h);

    await user.click(shareButton());

    expect((await screen.findByRole("alert")).textContent).toBe(SHARE_NO_LINK_MESSAGE);
    expect(screen.queryByRole("button", { name: "Open Form" })).toBeNull();
  });

  it("never builds a link from a malformed identifier", async () => {
    const h = handlers();
    h.loadPublicId.mockResolvedValue("../../admin?x=<script>");
    const { user } = mount({}, h);

    await user.click(shareButton());

    await screen.findByRole("alert");
    expect(screen.queryByLabelText("Public URL")).toBeNull();
  });

  it("reuses the loaded link when reopened", async () => {
    const { loadPublicId, user } = mount();

    await user.click(shareButton());
    await screen.findByLabelText("Public URL");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(shareButton());

    expect(await screen.findByLabelText("Public URL")).toBeTruthy();
    expect(loadPublicId).toHaveBeenCalledTimes(1);
  });

  it("closes with Escape, returns focus, and keeps focus inside while open", async () => {
    const { user } = mount();
    await user.click(shareButton());
    await screen.findByLabelText("Public URL");

    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    }

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(shareButton());
  });
});

describe("Share inside the builder", () => {
  const schemaWithField = (): FormSchema =>
    addField(createEmptyFormSchema(), createFieldDefinition("TEXT"));

  const publishResult: PublishResult = {
    formId: FORM_ID,
    versionId: "665f1c2e8f1b2c3d4e5f6a99",
    version: 1,
    status: "PUBLISHED",
    publishedAt: "2026-10-05T10:00:00.000Z",
  };

  const mountBuilder = (extra: Partial<React.ComponentProps<typeof FormBuilder>> = {}) => {
    const h = handlers();
    render(
      <FormBuilder
        formId={FORM_ID}
        initialSchema={schemaWithField()}
        saveDraft={() => Promise.resolve()}
        publish={() => Promise.resolve(publishResult)}
        shareHandlers={h}
        {...extra}
      />,
    );
    return { ...h, user: userEvent.setup() };
  };

  it("has no Share control for a draft form", () => {
    mountBuilder({ initialStatus: "DRAFT" });
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });

  it("offers Share for a form that was already published when opened", async () => {
    const { user, loadPublicId } = mountBuilder({
      initialStatus: "PUBLISHED",
      initiallyPublished: true,
    });

    await user.click(shareButton());

    expect(((await screen.findByLabelText("Public URL")) as HTMLInputElement).value).toBe(
      expectedUrl,
    );
    expect(loadPublicId).toHaveBeenCalledWith(FORM_ID);
  });

  it("appears right after a successful publish, and not before", async () => {
    const { user } = mountBuilder();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Publish" }));
    await user.click(
      screen.getByRole("dialog").querySelector<HTMLButtonElement>(".fb-button-primary")!,
    );

    await waitFor(() => expect(shareButton()).toBeTruthy());
  });

  it("does not offer Share when publishing fails", async () => {
    const { user } = mountBuilder({
      publish: () => Promise.reject(new Error("boom")),
    });

    await user.click(screen.getByRole("button", { name: "Publish" }));
    await user.click(
      screen.getByRole("dialog").querySelector<HTMLButtonElement>(".fb-button-primary")!,
    );
    await screen.findByRole("alert");

    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });
});
