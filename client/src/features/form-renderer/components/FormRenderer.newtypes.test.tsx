// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFieldDefinition } from "../../form-builder/utils/form-schema.utils.ts";
import { isFormSchema } from "../../form-builder/utils/form-schema.validate.ts";
import type {
  FormFieldDefinition,
  FormSchema,
} from "../../form-builder/types/form-builder.types.ts";
import type { FormSubmitHandler } from "../types/form-renderer.types.ts";
import { validateField } from "../utils/form-validation.ts";
import { FormRenderer } from "./FormRenderer.tsx";

afterEach(cleanup);

const withLabel = <F extends FormFieldDefinition>(field: F, label: string, extra: Partial<F> = {}): F => ({
  ...field,
  label,
  ...extra,
});

const bio = withLabel(createFieldDefinition("TEXTAREA", "bio"), "Bio", {
  validation: { maxLength: 10 },
});
const age = withLabel(createFieldDefinition("NUMBER", "age"), "Age", {
  required: true,
  validation: { min: 18, integer: true },
});
const phone = withLabel(createFieldDefinition("PHONE", "phone"), "Phone");
const site = withLabel(createFieldDefinition("URL", "site"), "Website");
const size = withLabel(createFieldDefinition("RADIO", "size"), "Size", { required: true });
const extras = withLabel(createFieldDefinition("MULTI_SELECT", "extras"), "Extras", {
  validation: { max: 1 },
});
const stars = withLabel(createFieldDefinition("RATING", "stars"), "Stars", { required: true });

const schema: FormSchema = { version: 1, fields: [bio, age, phone, site, size, extras, stars] };

describe("new field types", () => {
  it("registry defaults produce a valid schema", () => {
    expect(isFormSchema(schema)).toBe(true);
  });

  it("render accessible controls, validate, and submit typed values", async () => {
    const onSubmit = vi.fn<FormSubmitHandler>().mockResolvedValue({ ok: true, summary: "done" });
    const user = userEvent.setup();
    render(<FormRenderer schema={schema} mode="published" onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByText("Age is required")).toBeTruthy();
    expect(screen.getByText("Size is required")).toBeTruthy();
    expect(screen.getByText("Stars is required")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: "Bio" }), "Hello");
    await user.type(screen.getByRole("textbox", { name: /Age/ }), "17.5");
    expect(screen.getByText("Age must be a whole number")).toBeTruthy();
    await user.clear(screen.getByRole("textbox", { name: /Age/ }));
    await user.type(screen.getByRole("textbox", { name: /Age/ }), "30");

    await user.type(screen.getByRole("textbox", { name: "Phone" }), "12");
    await user.type(screen.getByRole("textbox", { name: "Website" }), "javascript:alert(1)");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByText("Phone must be a valid phone number")).toBeTruthy();
    expect(screen.getByText("Website must be a valid web address (http or https)")).toBeTruthy();

    await user.clear(screen.getByRole("textbox", { name: "Phone" }));
    await user.type(screen.getByRole("textbox", { name: "Phone" }), "+91 98765 43210");
    await user.clear(screen.getByRole("textbox", { name: "Website" }));
    await user.type(screen.getByRole("textbox", { name: "Website" }), "https://example.com");

    const sizeGroup = screen.getByRole("group", { name: /Size/ });
    await user.click(within(sizeGroup).getByRole("radio", { name: "Option 2" }));

    const extrasGroup = screen.getByRole("group", { name: "Extras" });
    await user.click(within(extrasGroup).getByRole("checkbox", { name: "Option 1" }));
    await user.click(within(extrasGroup).getByRole("checkbox", { name: "Option 2" }));
    expect(screen.getByText("Extras allows at most 1 selections")).toBeTruthy();
    await user.click(within(extrasGroup).getByRole("checkbox", { name: "Option 1" }));

    const starGroup = screen.getByRole("group", { name: /Stars/ });
    expect(within(starGroup).getAllByRole("radio")).toHaveLength(5);
    await user.click(within(starGroup).getByRole("radio", { name: "4 of 5" }));

    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toEqual({
      bio: "Hello",
      age: "30",
      phone: "+91 98765 43210",
      site: "https://example.com",
      size: "option-2",
      extras: ["option-2"],
      stars: "4",
    });
    // Many interactions; generous under a loaded full-suite run.
  }, 20_000);

  it("is read-only in builder mode", () => {
    render(<FormRenderer schema={schema} mode="builder" />);
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(screen.getByRole("group", { name: /Size/ }).hasAttribute("disabled")).toBe(true);
  });

  it("mirrors the server rules for values", () => {
    expect(validateField(age, "1e5")).toBe("Age must be a number");
    expect(validateField(age, "-20")).toBe("Age must be at least 18");
    expect(validateField(phone, "123-4567")).toBeNull();
    expect(validateField(phone, "1".repeat(16))).toBe("Phone must be a valid phone number");
    expect(validateField(site, "ftp://example.com")).toMatch(/valid web address/);
    expect(validateField(size, "nope")).toBe("Size must be one of the available options");
    expect(validateField(extras, ["nope"])).toBe("Extras must only contain the available options");
    expect(validateField(stars, "6")).toBe("Stars must be a rating from 1 to 5");
    expect(validateField(bio, "x".repeat(11))).toBe("Bio must be at most 10 characters");
  });
});
