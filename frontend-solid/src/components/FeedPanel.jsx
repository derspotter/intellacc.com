import { For, Show, createSignal } from "solid-js";
import { Panel } from "./ui/Panel";
import { feedStore } from "../store/feedStore";
import { api, ApiError } from "../services/api";

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

const PostItem = (props) => {
    const handleLike = async () => {
        const postId = props.post.id;
        if (props.post.liked_by_user) {
            feedStore.unlikePost(postId);
            try { await api.posts.unlikePost(postId); } catch { feedStore.likePost(postId); }
        } else {
            feedStore.likePost(postId);
            try { await api.posts.likePost(postId); } catch { feedStore.unlikePost(postId); }
        }
    };

    return (
        <div class="p-2 border-b border-bb-border/30 hover:bg-white/5 text-sm transition-colors">
            <div class="flex justify-between items-baseline mb-1">
                <span class="font-bold text-bb-accent text-xs">@{props.post.username}</span>
                <span class="text-xxs text-bb-muted font-mono">{new Date(props.post.created_at).toLocaleTimeString()}</span>
            </div>
            <p class="text-bb-text mb-2 break-words whitespace-pre-wrap">{props.post.content}</p>
            <div class="flex justify-between items-center text-xxs font-mono">
                <div class="flex gap-2 text-bb-muted">
                    <span>GRP: DEFAULT</span>
                    <span>ID: {props.post.id}</span>
                    <Show when={props.post.is_temp}>
                         <span class="text-yellow-500 animate-pulse">SENDING...</span>
                    </Show>
                </div>
                <button 
                    class={`cursor-pointer hover:text-white transition-colors uppercase ${props.post.liked_by_user ? 'text-market-up font-bold' : 'text-bb-muted'}`}
                    onClick={handleLike}
                    disabled={props.post.is_temp}
                >
                    [{props.post.liked_by_user ? 'LIKED' : 'LIKE'}:{props.post.like_count || 0}]
                </button>
            </div>
        </div>
    );
};

export const FeedPanel = () => {
    return (
        <Panel title="[1] FEED // LIVE" class="h-full flex flex-col">
            <PostComposer />
            <div class="flex-1 overflow-y-auto">
                <Show when={!feedStore.state.loading} fallback={<div class="p-2 text-bb-muted font-mono animate-pulse">Running query...</div>}>
                    <div class="flex flex-col">
                        <For each={feedStore.state.posts}>
                            {(post) => <PostItem post={post} />}
                        </For>
                    </div>
                </Show>
            </div>
        </Panel>
    );
};