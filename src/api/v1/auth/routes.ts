import { Hono } from "hono";
import { auth } from "../../../lib/auth";
import { z } from "zod";

const router = new Hono();

router.get("/me", async (c) => {
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ user: session.user });
  } catch (error) {
    console.error("Auth error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

router.post("/logout", async (c) => {
  try {
    await auth.api.signOut({ headers: c.req.raw.headers });
    return c.json({ success: true });
  } catch (error) {
    console.error("Logout error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

export default router;

// Email/password login
router.post("/login", async (c) => {
  try {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(6),
    });
    const body = await c.req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { email, password } = parsed.data;
    const res = await auth.api.signIn({
      body: { email, password },
      headers: c.req.raw.headers,
    });
    if (!res.status) return c.json({ error: "Invalid credentials" }, 401);
    return c.json({ success: true, user: res.user });
  } catch (error) {
    console.error("Login error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// Register new user and send verification email as configured in Better Auth
router.post("/register", async (c) => {
  try {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(6),
      name: z.string().min(1),
      role: z.string().min(1),
      phone_number: z.string().min(3),
    });
    const body = await c.req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const res = await auth.api.signUp({
      body: parsed.data,
      headers: c.req.raw.headers,
    });
    if (!res.status) return c.json({ error: "Registration failed" }, 400);
    return c.json({ success: true, user: res.user }, 201);
  } catch (error) {
    console.error("Register error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// Request a password reset email
router.post("/reset-password", async (c) => {
  try {
    const schema = z.object({ email: z.string().email() });
    const body = await c.req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const res = await auth.api.requestPasswordReset({
      body: { email: parsed.data.email },
      headers: c.req.raw.headers,
    });
    if (!("status" in res) || !res.status)
      return c.json({ error: "Request failed" }, 400);
    return c.json({ success: true });
  } catch (error) {
    console.error("Request reset error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// Complete password reset with token
router.post("/new-password", async (c) => {
  try {
    const schema = z.object({
      token: z.string().min(1),
      password: z.string().min(6),
    });
    const body = await c.req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const res = await auth.api.resetPassword({
      body: { token: parsed.data.token, newPassword: parsed.data.password },
      headers: c.req.raw.headers,
    });
    if (!("status" in res) || !res.status)
      return c.json({ error: "Reset failed" }, 400);
    return c.json({ success: true });
  } catch (error) {
    console.error("New password error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// Verify email via token
router.post("/verify-email", async (c) => {
  try {
    const schema = z.object({ token: z.string().min(1) });
    const body = await c.req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const res = await auth.api.verifyEmail({
      query: { token: parsed.data.token },
      headers: c.req.raw.headers,
    });
    if (!("status" in res) || !res.status)
      return c.json({ error: "Verification failed" }, 400);
    return c.json({ success: true });
  } catch (error) {
    console.error("Verify email error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});
