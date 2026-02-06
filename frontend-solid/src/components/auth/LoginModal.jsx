import { createSignal, Show } from "solid-js";
import { api } from "../../services/api";
import { saveToken, userData } from "../../services/tokenService";
import vaultService from "../../services/mls/vaultService";

export const LoginModal = () => {
    // Stage: 'email' | 'password' | 'register' | 'loading'
    const [stage, setStage] = createSignal("email");
    const [email, setEmail] = createSignal("");
    const [password, setPassword] = createSignal("");
    const [registerUsername, setRegisterUsername] = createSignal("");
    const [registerEmail, setRegisterEmail] = createSignal("");
    const [registerPassword, setRegisterPassword] = createSignal("");
    const [error, setError] = createSignal(null);

    // Handle email submit - just move to password stage (client-side only)
    const handleEmailSubmit = (e) => {
        e.preventDefault();
        if (!email().trim()) return;
        setError(null);
        setStage("password");
    };

    // Handle password submit - actual login
    const handlePasswordSubmit = async (e) => {
        e.preventDefault();
        if (!password()) return;

        setError(null);
        setStage("loading");

        try {
            const result = await api.auth.login(email(), password());

            if (result && result.token) {
                saveToken(result.token);

                // Try to auto-unlock/setup vault after login
                try {
                    const user = userData();
                    const userId = user?.username || String(user?.userId);
                    if (userId) {
                        const success = await vaultService.findAndUnlock(password(), userId);
                        if (!success) {
                            await vaultService.setupKeystoreWithPassword(password(), userId);
                        }
                    }
                } catch (vaultErr) {
                    console.warn('[LoginModal] Vault auto-unlock failed:', vaultErr);
                }
            } else {
                setError('Login failed: No token received');
                setStage("password");
            }
        } catch (err) {
            console.error(err);
            setError(err.message || "Login failed");
            setStage("password");
        }
    };

    const handleRegisterSubmit = async (e) => {
        e.preventDefault();

        const username = registerUsername().trim();
        const regEmail = registerEmail().trim();
        const regPassword = registerPassword();

        if (!username || !regEmail || !regPassword) return;

        setError(null);
        setStage("loading");

        try {
            await api.auth.register(username, regEmail, regPassword);
            const result = await api.auth.login(regEmail, regPassword);

            if (result && result.token) {
                saveToken(result.token);

                // Try to auto-unlock/setup vault after login
                try {
                    const user = userData();
                    const userId = user?.username || String(user?.userId);
                    if (userId) {
                        const success = await vaultService.findAndUnlock(regPassword, userId);
                        if (!success) {
                            await vaultService.setupKeystoreWithPassword(regPassword, userId);
                        }
                    }
                } catch (vaultErr) {
                    console.warn('[LoginModal] Vault auto-unlock failed:', vaultErr);
                }
            } else {
                setError("Login failed: No token received");
                setStage("register");
            }
        } catch (err) {
            console.error(err);
            setError(err.message || "Registration failed");
            setStage("register");
        }
    };

    // Go back to email stage
    const handleBack = () => {
        setError(null);
        setPassword("");
        setStage("email");
    };

    const handleGoToRegister = () => {
        setError(null);
        setRegisterEmail(email());
        setRegisterPassword(password());
        setStage("register");
    };

    const handleGoToLogin = () => {
        setError(null);
        setEmail(registerEmail());
        setPassword("");
        setStage("email");
    };

    return (
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
            <div class="w-full max-w-md bg-bb-panel border border-bb-border p-1 shadow-2xl">
                {/* Terminal Header */}
                {/* Terminal Header Removed */}


                <div class="p-4 pt-0">
                    <div class="font-mono text-center text-bb-accent mb-6 font-bold tracking-wider">
                        INTELLACC // GATEWAY
                    </div>

                    {/* Error Display */}
                    <Show when={error()}>
                        <div class="text-market-down border border-market-down/30 bg-market-down/10 p-2 text-xs mb-4 font-mono">
                            &gt; ERROR: {error()}
                        </div>
                    </Show>

                    {/* === EMAIL STAGE === */}
                    <Show when={stage() === "email"}>
                        <form onSubmit={handleEmailSubmit} class="flex flex-col gap-4 font-mono text-sm">
                            <div class="flex flex-col gap-1">
                                <label class="text-bb-muted text-xs uppercase">Credentials // Email</label>
                                <input
                                    type="email"
                                    value={email()}
                                    onInput={(e) => setEmail(e.target.value)}
                                    class="bg-bb-bg border border-bb-border p-2 text-bb-text focus:border-bb-accent focus:outline-none"
                                    placeholder="Enter system address..."
                                    required
                                    autofocus
                                />
                            </div>
                            <button type="submit" class="mt-2 bg-bb-accent text-bb-bg font-bold py-2 hover:bg-bb-accent/90 uppercase tracking-widest">
                                &gt; CONTINUE
                            </button>
                            <div class="text-center text-xs text-bb-muted">
                                Don't have an account?{" "}
                                <button
                                    type="button"
                                    onClick={handleGoToRegister}
                                    class="text-bb-accent hover:underline"
                                >
                                    Register here
                                </button>
                            </div>
                        </form>
                    </Show>

                    {/* === PASSWORD STAGE === */}
                    <Show when={stage() === "password"}>
                        <form onSubmit={handlePasswordSubmit} class="flex flex-col gap-4 font-mono text-sm">
                            <div class="text-bb-muted text-xs text-center mb-2">
                                Logging in as: <span class="text-bb-accent">{email()}</span>
                            </div>
                            <div class="flex flex-col gap-1">
                                <label class="text-bb-muted text-xs uppercase">Security // Password</label>
                                <input
                                    type="password"
                                    value={password()}
                                    onInput={(e) => setPassword(e.target.value)}
                                    class="bg-bb-bg border border-bb-border p-2 text-bb-text focus:border-bb-accent focus:outline-none"
                                    placeholder="Enter access key..."
                                    required
                                    autofocus
                                />
                            </div>
                            <button type="submit" class="mt-2 bg-bb-accent text-bb-bg font-bold py-2 hover:bg-bb-accent/90 uppercase tracking-widest">
                                &gt; SIGN IN
                            </button>
                            <button
                                type="button"
                                onClick={handleBack}
                                class="text-bb-muted text-xs hover:text-bb-text text-center"
                            >
                                Use a different email
                            </button>
                        </form>
                    </Show>

                    {/* === REGISTER STAGE === */}
                    <Show when={stage() === "register"}>
                        <form onSubmit={handleRegisterSubmit} class="flex flex-col gap-4 font-mono text-sm">
                            <div class="flex flex-col gap-1">
                                <label class="text-bb-muted text-xs uppercase">Identity // Username</label>
                                <input
                                    type="text"
                                    value={registerUsername()}
                                    onInput={(e) => setRegisterUsername(e.target.value)}
                                    class="bg-bb-bg border border-bb-border p-2 text-bb-text focus:border-bb-accent focus:outline-none"
                                    placeholder="Choose handle..."
                                    required
                                    autofocus
                                />
                            </div>
                            <div class="flex flex-col gap-1">
                                <label class="text-bb-muted text-xs uppercase">Credentials // Email</label>
                                <input
                                    type="email"
                                    value={registerEmail()}
                                    onInput={(e) => setRegisterEmail(e.target.value)}
                                    class="bg-bb-bg border border-bb-border p-2 text-bb-text focus:border-bb-accent focus:outline-none"
                                    placeholder="Enter system address..."
                                    required
                                />
                            </div>
                            <div class="flex flex-col gap-1">
                                <label class="text-bb-muted text-xs uppercase">Security // Password</label>
                                <input
                                    type="password"
                                    value={registerPassword()}
                                    onInput={(e) => setRegisterPassword(e.target.value)}
                                    class="bg-bb-bg border border-bb-border p-2 text-bb-text focus:border-bb-accent focus:outline-none"
                                    placeholder="Create access key..."
                                    required
                                />
                            </div>
                            <button type="submit" class="mt-2 bg-bb-accent text-bb-bg font-bold py-2 hover:bg-bb-accent/90 uppercase tracking-widest">
                                &gt; REGISTER
                            </button>
                            <div class="text-center text-xs text-bb-muted">
                                Already have an account?{" "}
                                <button
                                    type="button"
                                    onClick={handleGoToLogin}
                                    class="text-bb-accent hover:underline"
                                >
                                    Login here
                                </button>
                            </div>
                        </form>
                    </Show>

                    {/* === LOADING STAGE === */}
                    <Show when={stage() === "loading"}>
                        <div class="text-center py-8">
                            <div class="text-bb-accent animate-pulse text-lg font-mono">AUTHENTICATING...</div>
                        </div>
                    </Show>

                    <div class="mt-4 text-center text-xs text-bb-muted font-mono">
                        SECURE CONNECTION REQUIRED
                    </div>
                </div>
            </div>
        </div>
    );
};
