import { useState } from "react";
import { signUp, EmailTaken } from "../lib/api";
import { validateEmail } from "../lib/validate";
import { Button } from "./Button";

type Fields = { name: string; email: string; password: string };

const empty: Fields = { name: "", email: "", password: "" };

export function SignupForm() {
  const [fields, setFields] = useState<Fields>(empty);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setEmailError(null);
    try {
      await signUp(fields);
    } catch (problem) {
      // Keep what was typed: only the email needs changing.
      if (problem instanceof EmailTaken) {
        setEmailError("That email is taken.");
      } else {
        setError("Something went wrong. Try again in a moment.");
      }
    } finally {
      setSaving(false);
    }
  }

  const change = (key: keyof Fields) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setFields({ ...fields, [key]: event.target.value });

  return (
    <form className="signup-form" onSubmit={submit}>
      <label>
        Name
        <input value={fields.name} onChange={change("name")} />
      </label>
      <label>
        Email
        <input type="email" value={fields.email} onChange={change("email")} aria-invalid={!!emailError} />
        {emailError && <span className="field-error">{emailError}</span>}
      </label>
      <label>
        Password
        <input type="password" value={fields.password} onChange={change("password")} />
      </label>
      {error && <p className="error">{error}</p>}
      <Button type="submit" disabled={saving}>
        Sign up
      </Button>
    </form>
  );
}
