// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { FieldType, FormFieldDefinition } from "../types/form-builder.types.ts";
import { createFieldDefinition, updateField, type FieldChanges } from "../utils/form-schema.utils.ts";
import { isFormSchema } from "../utils/form-schema.validate.ts";
import { PropertiesPanel } from "./PropertiesPanel.tsx";

afterEach(cleanup);

let latest: FormFieldDefinition | null = null;

/* Real schema updates, so every edit can be checked against the validator. */
function Harness({ type }: { type: FieldType }) {
  const [schema, setSchema] = useState(() => ({
    version: 1,
    fields: [createFieldDefinition(type, "f")],
  }));
  useEffect(() => {
    latest = schema.fields[0]!;
  }, [schema]);

  return (
    <PropertiesPanel
      field={schema.fields[0]!}
      onUpdateField={(id: string, changes: FieldChanges) =>
        setSchema((current) => updateField(current, id, changes))
      }
    />
  );
}

const schemaOf = () => ({ version: 1, fields: [latest!] });

describe("PropertiesPanel for the new field types", () => {
  it("NUMBER: sets min, max and whole numbers, rejecting min > max", async () => {
    const user = userEvent.setup();
    render(<Harness type="NUMBER" />);

    await user.type(screen.getByLabelText("Minimum value"), "10");
    await user.type(screen.getByLabelText("Maximum value"), "5");
    expect(screen.getByText("Maximum cannot be less than minimum.")).toBeTruthy();
    await user.clear(screen.getByLabelText("Maximum value"));
    await user.type(screen.getByLabelText("Maximum value"), "99.5");
    await user.click(screen.getByRole("switch", { name: "Whole numbers only" }));

    expect(latest!.validation).toEqual({ min: 10, max: 99.5, integer: true });
    expect(isFormSchema(schemaOf())).toBe(true);
  });

  it("RADIO: edits options and stays valid", async () => {
    const user = userEvent.setup();
    render(<Harness type="RADIO" />);

    await user.click(screen.getByRole("button", { name: "+ Add option" }));
    expect(latest!.type === "RADIO" && latest!.config.options).toHaveLength(3);
    expect(isFormSchema(schemaOf())).toBe(true);
  });

  it("MULTI_SELECT: bounds the number of selections", async () => {
    const user = userEvent.setup();
    render(<Harness type="MULTI_SELECT" />);

    await user.type(screen.getByLabelText("Minimum selections"), "3");
    await user.type(screen.getByLabelText("Maximum selections"), "1");
    expect(screen.getByText("Maximum selections cannot be less than minimum selections.")).toBeTruthy();
    expect(latest!.validation).toEqual({ min: 3 });
  });

  it("RATING: changes the scale and clamps the default", async () => {
    const user = userEvent.setup();
    render(<Harness type="RATING" />);

    await user.selectOptions(screen.getByLabelText("Number of stars"), "10");
    await user.selectOptions(screen.getByLabelText("Default rating"), "8");
    await user.selectOptions(screen.getByLabelText("Number of stars"), "4");

    expect(latest!.config).toEqual({ max: 4, defaultValue: 4 });
    expect(isFormSchema(schemaOf())).toBe(true);
  });

  it.each(["TEXTAREA", "PHONE", "URL"] as const)("%s: has placeholder and length rules", (type) => {
    render(<Harness type={type} />);
    expect(screen.getByLabelText("Placeholder")).toBeTruthy();
    expect(screen.getByLabelText("Maximum length")).toBeTruthy();
  });
});
