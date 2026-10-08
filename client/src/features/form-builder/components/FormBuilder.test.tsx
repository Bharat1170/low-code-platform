// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { listFieldRegistryEntries } from "../registry/field-registry.ts";
import type { FormSchema } from "../types/form-builder.types.ts";
import {
  addField,
  createEmptyFormSchema,
  createFieldDefinition,
} from "../utils/form-schema.utils.ts";
import { FormBuilder } from "./FormBuilder.tsx";

afterEach(cleanup);

const addViaPalette = async (
  user: ReturnType<typeof userEvent.setup>,
  label: string,
) => {
  await user.click(screen.getByRole("button", { name: `Add ${label} field` }));
};

const canvas = () => screen.getByRole("main", { name: "Form canvas" });
const fieldCards = () => within(canvas()).queryAllByRole("listitem");

describe("FormBuilder", () => {
  it("renders the builder with an empty state", () => {
    render(<FormBuilder />);

    expect(screen.getByRole("heading", { name: "Form Builder" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Field palette" })).toBeTruthy();
    expect(canvas()).toBeTruthy();
  });

  it("renders a palette entry for every registry field type, from registry data", () => {
    render(<FormBuilder />);

    const entries = listFieldRegistryEntries();
    expect(entries).toHaveLength(12);

    const palette = screen.getByRole("complementary", { name: "Field palette" });
    const buttons = within(palette).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(
      entries.map((entry) => `Add ${entry.label} field`),
    );
  });

  it("shows a functional empty state", async () => {
    const user = userEvent.setup();
    render(<FormBuilder />);

    expect(screen.getByRole("heading", { name: "Build your form" })).toBeTruthy();
    expect(fieldCards()).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: /add your first field/i }));

    expect(fieldCards()).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Build your form" })).toBeNull();
  });

  it.each(["Text", "Email", "Dropdown", "Checkbox"])(
    "adds a %s field to the canvas and selects it",
    async (label) => {
      const user = userEvent.setup();
      render(<FormBuilder />);

      await addViaPalette(user, label);

      expect(fieldCards()).toHaveLength(1);
      const select = within(canvas()).getByRole("button", {
        name: /^Select .* field$/,
      });
      expect(select.getAttribute("aria-pressed")).toBe("true");
    },
  );

  it("adds multiple fields in schema order with unique ids", async () => {
    const user = userEvent.setup();
    const { container } = render(<FormBuilder />);

    await addViaPalette(user, "Text");
    await addViaPalette(user, "Email");
    await addViaPalette(user, "Dropdown");
    await addViaPalette(user, "Checkbox");
    await addViaPalette(user, "Text");

    const cards = fieldCards();
    expect(cards.map((c) => c.getAttribute("data-field-type"))).toEqual([
      "TEXT",
      "EMAIL",
      "DROPDOWN",
      "CHECKBOX",
      "TEXT",
    ]);

    const ids = [...container.querySelectorAll("[id$='-preview']")].map(
      (el) => el.id,
    );
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it("selects one field at a time and represents it visually", async () => {
    const user = userEvent.setup();
    render(<FormBuilder />);

    await addViaPalette(user, "Text");
    await addViaPalette(user, "Email");

    // The newest field is selected after adding.
    let cards = fieldCards();
    expect(cards[0].getAttribute("data-selected")).toBe("false");
    expect(cards[1].getAttribute("data-selected")).toBe("true");
    expect(within(cards[1]).getByText("Selected")).toBeTruthy();

    await user.click(within(cards[0]).getByRole("button", { name: /^Select/ }));

    cards = fieldCards();
    expect(cards[0].getAttribute("data-selected")).toBe("true");
    expect(cards[1].getAttribute("data-selected")).toBe("false");
    expect(within(cards[0]).getByText("Selected")).toBeTruthy();
    expect(within(cards[1]).queryByText("Selected")).toBeNull();
  });

  it("removes a field and leaves the others intact", async () => {
    const user = userEvent.setup();
    render(<FormBuilder />);

    await addViaPalette(user, "Text");
    await addViaPalette(user, "Email");
    await addViaPalette(user, "Checkbox");

    await user.click(screen.getByRole("button", { name: "Remove Email field" }));

    expect(fieldCards().map((c) => c.getAttribute("data-field-type"))).toEqual([
      "TEXT",
      "CHECKBOX",
    ]);
  });

  it("clears the selection when the selected field is removed", async () => {
    const user = userEvent.setup();
    render(<FormBuilder />);

    await addViaPalette(user, "Text");
    await addViaPalette(user, "Email");
    // Email is selected; remove it.
    await user.click(screen.getByRole("button", { name: "Remove Email field" }));

    expect(screen.queryByText("Selected")).toBeNull();
    const [remaining] = fieldCards();
    expect(remaining.getAttribute("data-selected")).toBe("false");
  });

  it("keeps the selection when a different field is removed", async () => {
    const user = userEvent.setup();
    render(<FormBuilder />);

    await addViaPalette(user, "Text");
    await addViaPalette(user, "Email");
    await user.click(screen.getByRole("button", { name: "Remove Text field" }));

    const [remaining] = fieldCards();
    expect(remaining.getAttribute("data-selected")).toBe("true");
  });

  it("returns to the empty state after the last field is removed", async () => {
    const user = userEvent.setup();
    render(<FormBuilder />);

    await addViaPalette(user, "Text");
    await user.click(screen.getByRole("button", { name: "Remove Text field" }));

    expect(screen.getByRole("heading", { name: "Build your form" })).toBeTruthy();
  });

  it("renders dropdown options", async () => {
    const user = userEvent.setup();
    render(<FormBuilder />);

    await addViaPalette(user, "Dropdown");

    const select = within(canvas()).getByRole("combobox");
    const options = within(select).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Select an option",
      "Option 1",
      "Option 2",
    ]);
  });

  it("renders text and email placeholders as labelled inputs", () => {
    let schema: FormSchema = createEmptyFormSchema();
    const text = createFieldDefinition("TEXT", "name_field");
    text.label = "Name";
    text.config.placeholder = "Enter your name";
    const email = createFieldDefinition("EMAIL", "email_field");
    email.config.placeholder = "you@example.com";
    schema = addField(addField(schema, text), email);

    render(<FormBuilder initialSchema={schema} />);

    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    expect(nameInput.type).toBe("text");
    expect(nameInput.placeholder).toBe("Enter your name");

    const emailInput = screen.getByLabelText("Email") as HTMLInputElement;
    expect(emailInput.type).toBe("email");
    expect(emailInput.placeholder).toBe("you@example.com");
  });

  it("renders a checkbox with its label", async () => {
    const user = userEvent.setup();
    render(<FormBuilder />);

    await addViaPalette(user, "Checkbox");

    const checkbox = screen.getByLabelText("Checkbox") as HTMLInputElement;
    expect(checkbox.type).toBe("checkbox");
    expect(checkbox.checked).toBe(false);
  });

  it("renders labels as text, never as HTML", () => {
    const field = createFieldDefinition("TEXT", "xss_field");
    field.label = "<img src=x onerror=alert(1)>";
    const schema = addField(createEmptyFormSchema(), field);

    const { container } = render(<FormBuilder initialSchema={schema} />);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText("<img src=x onerror=alert(1)>").length).toBeGreaterThan(0);
  });

  it("does not mutate the original schema", async () => {
    const user = userEvent.setup();
    const existing = createFieldDefinition("TEXT", "existing_field");
    const schema = addField(createEmptyFormSchema(), existing);
    const snapshot = structuredClone(schema);

    render(<FormBuilder initialSchema={schema} />);

    await addViaPalette(user, "Email");
    await user.click(screen.getByRole("button", { name: "Remove Text field" }));

    expect(schema).toEqual(snapshot);
    expect(schema.fields).toHaveLength(1);
  });

  it("supports keyboard activation of add, select and remove", async () => {
    const user = userEvent.setup();
    render(<FormBuilder />);

    const addText = screen.getByRole("button", { name: "Add Text field" });
    expect(addText.tagName).toBe("BUTTON");
    addText.focus();
    expect(document.activeElement).toBe(addText);
    await user.keyboard("{Enter}");
    expect(fieldCards()).toHaveLength(1);

    const remove = screen.getByRole("button", { name: "Remove Text field" });
    expect(remove.tagName).toBe("BUTTON");
    remove.focus();
    await user.keyboard(" ");
    expect(fieldCards()).toHaveLength(0);
  });

  it("gives every remove button an accessible label naming its field", async () => {
    const user = userEvent.setup();
    render(<FormBuilder />);

    await addViaPalette(user, "Text");
    await addViaPalette(user, "Email");

    const labels = screen
      .getAllByRole("button", { name: /^Remove / })
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Remove Text field", "Remove Email field"]);
  });
});
