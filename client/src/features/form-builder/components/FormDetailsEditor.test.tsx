// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormBuilder } from "./FormBuilder.tsx";
import { FormDetailsEditor, type FormDetails } from "./FormDetailsEditor.tsx";

afterEach(cleanup);

type Save = (details: FormDetails) => Promise<void>;

describe("FormDetailsEditor", () => {
  it("saves a trimmed name and description on blur, once", async () => {
    const onSave = vi.fn<Save>().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<FormDetailsEditor initialName="Untitled form" initialDescription="" onSave={onSave} />);

    const name = screen.getByRole("textbox", { name: "Form name" });
    await user.clear(name);
    await user.type(name, "  Event sign-up  ");
    await user.type(screen.getByRole("textbox", { name: "Form description" }), "Join us!");
    await user.tab();

    expect(onSave).toHaveBeenLastCalledWith({ name: "Event sign-up", description: "Join us!" });
    expect(await screen.findByText("Name and description saved")).toBeTruthy();

    // Unchanged values are not saved again.
    const calls = onSave.mock.calls.length;
    await user.click(name);
    await user.tab();
    expect(onSave).toHaveBeenCalledTimes(calls);
  });

  it("requires a name and restores it with Escape", async () => {
    const onSave = vi.fn<Save>().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<FormDetailsEditor initialName="Survey" initialDescription="" onSave={onSave} />);

    const name = screen.getByRole("textbox", { name: "Form name" });
    await user.clear(name);
    await user.tab();
    expect(screen.getByText("The form needs a name.")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();

    await user.click(name);
    await user.keyboard("{Escape}");
    expect((name as HTMLInputElement).value).toBe("Survey");
  });

  it("keeps the edit and reports a failed save", async () => {
    const onSave = vi.fn<Save>().mockRejectedValue(new Error("down"));
    const user = userEvent.setup();
    render(<FormDetailsEditor initialName="Survey" initialDescription="" onSave={onSave} />);

    const name = screen.getByRole("textbox", { name: "Form name" });
    await user.type(name, " 2026{Enter}");

    expect(await screen.findByText(/Couldn't save the name/)).toBeTruthy();
    expect((name as HTMLInputElement).value).toBe("Survey 2026");
  });

  it("is wired into the builder and saves through saveDetails", async () => {
    const saveDetails = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <FormBuilder
          formId="665f1c2e8f1b2c3d4e5f6a7b"
          initialName="Old name"
          initialDescription=""
          saveDraft={vi.fn().mockResolvedValue(undefined)}
          saveDetails={saveDetails}
        />
      </MemoryRouter>,
    );

    const name = screen.getByRole("textbox", { name: "Form name" });
    expect((name as HTMLInputElement).value).toBe("Old name");
    await user.clear(name);
    await user.type(name, "New name{Enter}");

    expect(saveDetails).toHaveBeenCalledWith("665f1c2e8f1b2c3d4e5f6a7b", {
      name: "New name",
      description: "",
    });
  });
});
