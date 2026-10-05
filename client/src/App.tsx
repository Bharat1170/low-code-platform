import { useState } from "react";
import { Link, Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { AccountMenu } from "./features/auth/components/AccountMenu.tsx";
import { LoginPage } from "./features/auth/pages/LoginPage.tsx";
import { RegisterPage } from "./features/auth/pages/RegisterPage.tsx";
import { PublicOnly } from "./features/auth/routing/PublicOnly.tsx";
import { RequireAuth } from "./features/auth/routing/RequireAuth.tsx";
import { createDraftForm } from "./features/form-builder/api/forms.api.ts";
import { FormBuilder } from "./features/form-builder/components/FormBuilder.tsx";
import { PublishedFormPage } from "./features/form-renderer/components/PublishedFormPage.tsx";
import { SubmissionDetailsPage } from "./features/submissions/pages/SubmissionDetailsPage.tsx";
import { SubmissionsPage } from "./features/submissions/pages/SubmissionsPage.tsx";
import { FormBuilderPage } from "./features/form-builder/components/FormBuilderPage.tsx";

/*
 * The form to edit is chosen with ?formId=<id>. Without it the builder
 * opens empty; the first save (autosave, Save Draft or Publish) creates a
 * draft form on the server, after which the URL carries its id so a
 * reload reopens it.
 */
function BuilderRoute() {
  const [params] = useSearchParams();
  const urlFormId = params.get("formId");
  const [createdId, setCreatedId] = useState<string | null>(null);
  const formId = urlFormId ?? createdId;
  const account = (
    <>
      {formId && (
        <Link
          className="fb-button"
          to={`/forms/${encodeURIComponent(formId)}/submissions`}
        >
          Submissions
        </Link>
      )}
      <AccountMenu />
    </>
  );

  return urlFormId ? (
    <FormBuilderPage key={urlFormId} formId={urlFormId} headerExtras={account} />
  ) : (
    <FormBuilder
      createForm={createDraftForm}
      onFormCreated={(id) => {
        setCreatedId(id);
        // Same history entry and router state; only the address changes.
        window.history.replaceState(
          window.history.state,
          "",
          `/?formId=${encodeURIComponent(id)}`,
        );
      }}
      headerExtras={account}
    />
  );
}

function App() {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route path="/" element={<BuilderRoute />} />
        <Route path="/forms/:formId/preview" element={<PublishedFormPage />} />
        <Route path="/forms/:formId/submissions" element={<SubmissionsPage />} />
        <Route
          path="/forms/:formId/submissions/:submissionId"
          element={<SubmissionDetailsPage />}
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App
