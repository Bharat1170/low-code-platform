import { useCallback, useEffect, useRef, useState } from "react";
import type { FormSchema } from "../types/form-builder.types.ts";
import { areSchemasEqual } from "../utils/form-schema.utils.ts";

/* Debounce between the last edit and the autosave request. */
export const AUTOSAVE_DELAY_MS = 750;

export type SaveStatus = "saved" | "dirty" | "saving" | "error";

interface UseDraftAutosaveOptions {
  schema: FormSchema;
  enabled: boolean;
  save: (schema: FormSchema) => Promise<void>;
  delayMs?: number;
}

/*
 * Debounced autosave plus manual save for the builder draft. Autosave,
 * Save Draft and "save before publishing" all go through the same
 * runSave().
 *
 * State is minimal and local: the last successfully saved schema, the
 * schema of a failed save, and whether a request is running. "Dirty" is
 * never stored; it is derived by comparing the current schema with the
 * saved one, so a response for an older snapshot can never make newer
 * edits look saved: a save only ever records the snapshot it sent.
 *
 * One request runs at a time. An edit made while a save is running is
 * saved by the next debounce after that save finishes.
 */
export function useDraftAutosave({
  schema,
  enabled,
  save,
  delayMs = AUTOSAVE_DELAY_MS,
}: UseDraftAutosaveOptions) {
  const [savedSchema, setSavedSchema] = useState<FormSchema>(schema);
  const [failedSchema, setFailedSchema] = useState<FormSchema | null>(null);
  const [saving, setSaving] = useState(false);

  const saveRef = useRef(save);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const mountedRef = useRef(true);
  // Latest values for ensureSaved(), which can be called from an old closure.
  const schemaRef = useRef(schema);
  const savedRef = useRef(schema);

  useEffect(() => {
    saveRef.current = save;
    schemaRef.current = schema;
  }, [save, schema]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* Resolves true when the snapshot was saved. Never rejects. */
  const runSave = useCallback((snapshot: FormSchema): Promise<boolean> => {
    if (inFlightRef.current) {
      return inFlightRef.current;
    }

    setSaving(true);

    const request = (async () => {
      let succeeded: boolean;
      try {
        await saveRef.current(snapshot);
        succeeded = true;
      } catch {
        succeeded = false;
      }

      inFlightRef.current = null;
      if (succeeded) {
        savedRef.current = snapshot;
      }

      if (mountedRef.current) {
        setSaving(false);

        if (succeeded) {
          setSavedSchema(snapshot);
          setFailedSchema(null);
        } else {
          setFailedSchema(snapshot);
        }
      }

      return succeeded;
    })();

    inFlightRef.current = request;
    return request;
  }, []);

  const isDirty = !areSchemasEqual(schema, savedSchema);
  const failedForCurrent =
    failedSchema !== null && areSchemasEqual(schema, failedSchema);

  // Debounced autosave. Every schema change clears the previous timer, so
  // a burst of edits produces one request. A failed schema is not retried
  // automatically; the next edit or a manual save retries.
  useEffect(() => {
    if (!enabled || saving || !isDirty || failedForCurrent) {
      return;
    }

    const timer = setTimeout(() => {
      void runSave(schema);
    }, delayMs);

    return () => {
      clearTimeout(timer);
    };
  }, [schema, enabled, saving, isDirty, failedForCurrent, delayMs, runSave]);

  const saveNow = useCallback(() => {
    if (enabled && !saving && isDirty) {
      void runSave(schema);
    }
  }, [enabled, saving, isDirty, runSave, schema]);

  /*
   * Makes sure the LATEST edits are saved, waiting for a running save and
   * saving again if the editor moved on meanwhile. Resolves true only when
   * the saved schema equals the current one, so publishing can never use a
   * stale draft. `force` saves even when nothing changed (used when the
   * form does not exist on the server yet). Never rejects.
   */
  const ensureSaved = useCallback(
    async (force = false): Promise<boolean> => {
      if (!enabled) return false;

      let mustSave = force;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (inFlightRef.current) {
          const ok = await inFlightRef.current;
          if (!ok) return false;
          // A forced save that was already running has done its job.
          mustSave = false;
        }

        const latest = schemaRef.current;
        if (!mustSave && areSchemasEqual(latest, savedRef.current)) {
          return true;
        }

        mustSave = false;
        if (!(await runSave(latest))) return false;
      }

      return areSchemasEqual(schemaRef.current, savedRef.current);
    },
    [enabled, runSave],
  );

  let status: SaveStatus = "saved";
  if (saving) {
    status = "saving";
  } else if (isDirty) {
    status = failedForCurrent ? "error" : "dirty";
  }

  return { status, saveNow, ensureSaved };
}
