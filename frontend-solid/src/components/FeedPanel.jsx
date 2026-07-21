import { For, Show, createSignal, createMemo, onMount } from "solid-js";
import { Panel } from "./ui/Panel";
import { feedStore } from "../store/feedStore";
import { api, ApiError, getFeedWeights } from "../services/api";
import { rankPosts, normalizeWeights } from "../lib/feedRanking";
import PostItem from "./terminal/PostItem";

const PostComposer = () => {
    const [content, setContent] = createSignal("");
    const [submitting, setSubmitting] = createSignal(false);
    const [verifyBanner, setVerifyBanner] = createSignal(null); // null | 'needs_verify' | 'sending' | 'sent' | 'error'
    const [postError, setPostError] = createSignal(null);

    const handleSubmit = async (e) => {
        if (e) e.preventDefault();
        if (!content().trim() || submitting()) return;

        setSubmitting(true);
        setPostError(null);
        try {
            // Call the API directly first to catch 403 before any optimistic UI
            const newPost = await api.posts.create(content());
            feedStore.addPost(newPost);
            setContent("");
            setVerifyBanner(null);
        } catch (err) {
            if (err instanceof ApiError && err.status === 403 && err.data?.required_tier_name === 'email') {
                setVerifyBanner('needs_verify');
            } else {
                setPostError(err.message || 'Failed to submit post');
            }
            console.error("Failed to submit post:", err);
        } finally {
            setSubmitting(false);
        }
    };

    const handleSendVerification = async () => {
        setVerifyBanner('sending');
        try {
            await api.verification.sendEmailVerification();
            setVerifyBanner('sent');
        } catch (err) {
            console.error("Failed to send verification email:", err);
            setVerifyBanner('error');
        }
    };

    return (
        <div class="p-3 border-b border-bb-border/30 bg-bb-panel/50">
            <Show when={verifyBanner()}>
                <div class="mb-2 p-2 border font-mono text-xs" classList={{
                    'border-yellow-500/50 bg-yellow-500/10 text-yellow-400': verifyBanner() === 'needs_verify',
                    'border-bb-accent/50 bg-bb-accent/10 text-bb-accent': verifyBanner() === 'sending',
                    'border-market-up/50 bg-market-up/10 text-market-up': verifyBanner() === 'sent',
                    'border-market-down/50 bg-market-down/10 text-market-down': verifyBanner() === 'error',
                }}>
                    <Show when={verifyBanner() === 'needs_verify'}>
                        <div class="flex items-center justify-between gap-2">
                            <span>EMAIL VERIFICATION REQUIRED // VERIFY TO POST</span>
                            <button
                                class="px-2 py-0.5 border border-yellow-500 text-yellow-400 hover:bg-yellow-500/20 transition-colors whitespace-nowrap"
                                onClick={handleSendVerification}
                            >
                                SEND VERIFICATION
                            </button>
                        </div>
                    </Show>
                    <Show when={verifyBanner() === 'sending'}>
                        <span class="animate-pulse">SENDING VERIFICATION EMAIL...</span>
                    </Show>
                    <Show when={verifyBanner() === 'sent'}>
                        <span>VERIFICATION EMAIL SENT // CHECK YOUR INBOX</span>
                    </Show>
                    <Show when={verifyBanner() === 'error'}>
                        <div class="flex items-center justify-between gap-2">
                            <span>FAILED TO SEND // TRY AGAIN</span>
                            <button
                                class="px-2 py-0.5 border border-market-down text-market-down hover:bg-market-down/20 transition-colors whitespace-nowrap"
                                onClick={handleSendVerification}
                            >
                                RETRY
                            </button>
                        </div>
                    </Show>
                </div>
            </Show>
            <Show when={postError()}>
                <div class="mb-2 p-2 border border-market-down/50 bg-market-down/10 text-market-down font-mono text-xs">
                    ERROR // {postError().toUpperCase()}
                </div>
            </Show>
            <textarea
                class="w-full bg-black/20 border border-bb-border text-bb-text font-mono text-sm p-2 focus:outline-none focus:border-bb-accent h-20 resize-none placeholder-bb-muted/50 block"
                placeholder="TRANSMIT TO FEED..."
                value={content()}
                onInput={(e) => setContent(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSubmit();
                    }
                }}
            />
            <div class="flex justify-end mt-2">
                <button
                    class="px-4 py-1 bg-bb-accent/10 border border-bb-accent text-bb-accent text-xs font-bold hover:bg-bb-accent/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-mono tracking-wider"
                    onClick={(e) => handleSubmit(e)}
                    disabled={!content().trim() || submitting()}
                >
                    {submitting() ? "TRANSMITTING..." : "SUBMIT"}
                </button>
            </div>
        </div>
    );
};

export const FeedPanel = () => {
    const [weights, setWeights] = createSignal(null);
    onMount(() => {
        // Normalize to a 100-sum before ranking; null (no usable weights,
        // e.g. { weights: null } for a fresh user) keeps the server order.
        getFeedWeights().then(w => setWeights(normalizeWeights(w?.weights ?? w))).catch(() => {});
    });
    const rankedPosts = createMemo(() => rankPosts(feedStore.state.posts, weights()));

    return (
        <Panel title="[1] FEED // LIVE" class="h-full flex flex-col">
            <PostComposer />
            <Show when={feedStore.state.discoverMode}>
                <div data-testid="feed-discover-banner" class="px-2 py-1 text-xxs text-bb-tmux border-b border-bb-border/40 bg-bb-panel/60 uppercase">
                    [DISCOVER MODE] TOP PREDICTORS IN YOUR TOPICS — FOLLOW TO BUILD YOUR FEED
                </div>
            </Show>
            <div class="flex-1 overflow-y-auto">
                <Show when={!feedStore.state.loading} fallback={<div class="p-2 text-bb-muted font-mono animate-pulse">Running query...</div>}>
                    <Show
                        when={rankedPosts().length > 0}
                        fallback={
                            <Show when={!feedStore.state.discoverMode}>
                                <div data-testid="feed-empty" class="p-4 text-bb-muted font-mono text-xs">FEED EMPTY // FOLLOW USERS OR CHECK BACK LATER</div>
                            </Show>
                        }
                    >
                        <div class="flex flex-col">
                            <For each={rankedPosts()}>
                                {(post) => <PostItem post={post} />}
                            </For>
                        </div>
                        <Show when={feedStore.state.hasMore}>
                            <button
                                type="button"
                                data-testid="feed-load-more"
                                class="w-full py-2 text-center text-bb-accent hover:bg-bb-accent/10 uppercase font-bold font-mono text-xs disabled:opacity-50"
                                disabled={feedStore.state.loadingMore}
                                onClick={() => feedStore.loadMore()}
                            >
                                {feedStore.state.loadingMore ? 'LOADING...' : 'LOAD MORE'}
                            </button>
                        </Show>
                    </Show>
                </Show>
            </div>
        </Panel>
    );
};
