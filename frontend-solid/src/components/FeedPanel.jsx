import { For, Show, createSignal, createEffect, createMemo, onMount, onCleanup } from "solid-js";
import { Panel } from "./ui/Panel";
import { feedStore } from "../store/feedStore";
import { api, ApiError, getPostComments, createComment, requestBlob, followUser, getFeedWeights } from "../services/api";
import { rankPosts } from "../lib/feedRanking";

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

const CommentItem = (props) => (
    <div data-testid="comment-row" class="pl-3 border-l border-bb-border/40 py-1">
        <div class="flex justify-between items-baseline">
            <span class="font-bold text-bb-accent text-xxs">@{props.comment.username}</span>
            <span class="text-xxs text-bb-muted font-mono">
                {props.comment.created_at ? new Date(props.comment.created_at).toLocaleTimeString() : ''}
            </span>
        </div>
        <p class="text-bb-text text-xs break-words whitespace-pre-wrap">{props.comment.content}</p>
        <Show when={Array.isArray(props.comment.replies) && props.comment.replies.length > 0}>
            <For each={props.comment.replies}>
                {(reply) => <CommentItem comment={reply} />}
            </For>
        </Show>
    </div>
);

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

    const [showComments, setShowComments] = createSignal(false);
    const [comments, setComments] = createSignal([]);
    const [commentsLoaded, setCommentsLoaded] = createSignal(false);
    const [commentsError, setCommentsError] = createSignal(false);
    const [commentText, setCommentText] = createSignal("");
    const [commentBusy, setCommentBusy] = createSignal(false);
    const [repostBusy, setRepostBusy] = createSignal(false);
    const commentCount = () => Number(props.post.comment_count || 0) + comments().filter(c => c.__local).length;

    const [attachmentSrc, setAttachmentSrc] = createSignal(null);
    createEffect(() => {
        const id = props.post.image_attachment_id;
        if (!id) { setAttachmentSrc(null); return; }
        let revoked = false;
        let url = null;
        requestBlob(`/attachments/${id}`)
            .then((blob) => {
                if (revoked) return;
                url = URL.createObjectURL(blob);
                setAttachmentSrc(url);
            })
            .catch(() => setAttachmentSrc(null));
        onCleanup(() => {
            revoked = true;
            if (url) URL.revokeObjectURL(url);
        });
    });

    const toggleComments = async () => {
        const next = !showComments();
        setShowComments(next);
        if (next && !commentsLoaded()) {
            try {
                const rows = await getPostComments(props.post.id);
                setComments(Array.isArray(rows) ? rows : (rows?.comments || []));
                setCommentsError(false);
                setCommentsLoaded(true);
            } catch (err) {
                console.error("Failed to load comments", err);
                setCommentsError(true);
            }
        }
    };

    const submitComment = async () => {
        const text = commentText().trim();
        if (!text || commentBusy()) return;
        setCommentBusy(true);
        try {
            const created = await createComment(props.post.id, text);
            setComments((prev) => [...prev, { ...created, __local: true }]);
            setCommentText("");
        } catch (err) {
            console.error("Failed to comment", err);
        } finally {
            setCommentBusy(false);
        }
    };

    return (
        <div data-testid="feed-post" class="p-2 border-b border-bb-border/30 hover:bg-white/5 text-sm transition-colors">
            <div class="flex justify-between items-baseline mb-1">
                <span class="font-bold text-bb-accent text-xs">@{props.post.username}</span>
                <span class="text-xxs text-bb-muted font-mono">{new Date(props.post.created_at).toLocaleTimeString()}</span>
            </div>
            <p class="text-bb-text mb-2 break-words whitespace-pre-wrap">{props.post.content}</p>
            <Show when={attachmentSrc()}>
                <img src={attachmentSrc()} alt="" class="max-w-full max-h-64 border border-bb-border my-1" />
            </Show>
            <Show when={props.post.reposted_post}>
                <div data-testid="repost-embed" class="border border-bb-border/60 bg-black/20 p-2 my-1 text-xs">
                    <span class="text-bb-accent font-bold text-xxs">RT @{props.post.reposted_post.username}</span>
                    <p class="text-bb-text break-words whitespace-pre-wrap">{props.post.reposted_post.content}</p>
                </div>
            </Show>
            <div class="flex justify-between items-center text-xxs font-mono">
                <div class="flex gap-2 text-bb-muted">
                    <span>GRP: DEFAULT</span>
                    <span>ID: {props.post.id}</span>
                    <Show when={props.post.is_temp}>
                         <span class="text-yellow-500 animate-pulse">SENDING...</span>
                    </Show>
                </div>
                <div class="flex gap-2">
                    <button
                        type="button"
                        data-testid="post-repost"
                        class={`cursor-pointer hover:text-white transition-colors uppercase ${props.post.reposted_by_user ? 'text-market-neutral font-bold' : 'text-bb-muted'}`}
                        disabled={props.post.is_temp || props.post.reposted_by_user || repostBusy()}
                        onClick={() => {
                            setRepostBusy(true);
                            feedStore.createPost('', null, null, props.post.id)
                                .then((newPost) => {
                                    // The create endpoint only echoes repost_id, not the nested
                                    // original (that's assembled server-side only on feed GETs).
                                    // Attach it from the already-loaded source post so the embed
                                    // renders immediately without a refetch.
                                    if (newPost?.id) {
                                        feedStore.updatePost({
                                            id: newPost.id,
                                            reposted_post: {
                                                username: props.post.username,
                                                content: props.post.content,
                                                created_at: props.post.created_at
                                            }
                                        });
                                    }
                                })
                                .catch((err) => console.error('Repost failed', err))
                                .finally(() => setRepostBusy(false));
                        }}
                    >
                        [RT:{props.post.repost_count || 0}]
                    </button>
                    <button
                        type="button"
                        class={`cursor-pointer hover:text-white transition-colors uppercase ${props.post.liked_by_user ? 'text-market-up font-bold' : 'text-bb-muted'}`}
                        onClick={handleLike}
                        disabled={props.post.is_temp}
                    >
                        [{props.post.liked_by_user ? 'LIKED' : 'LIKE'}:{props.post.like_count || 0}]
                    </button>
                    <Show when={feedStore.state.discoverMode}>
                        <button
                            type="button"
                            data-testid="discover-follow"
                            class="text-bb-accent hover:text-white uppercase"
                            onClick={async () => {
                                try { await followUser(props.post.user_id); feedStore.loadPosts(); } catch (err) { console.error('Follow failed', err); }
                            }}
                        >
                            [FOLLOW]
                        </button>
                    </Show>
                </div>
            </div>
            <div class="flex gap-2 text-xxs font-mono mt-1">
                <button
                    type="button"
                    data-testid="post-comments-toggle"
                    class="text-bb-muted hover:text-bb-accent uppercase"
                    onClick={toggleComments}
                >
                    [CMT:{commentCount()}]
                </button>
            </div>
            <Show when={showComments()}>
                <div class="mt-2">
                    <Show when={commentsError()}>
                        <div class="text-xxs text-market-down">ERROR // FAILED TO LOAD COMMENTS</div>
                    </Show>
                    <Show when={!commentsError()}>
                        <Show when={commentsLoaded()} fallback={<div class="text-xxs text-bb-muted animate-pulse">LOADING COMMENTS...</div>}>
                            <For each={comments()}>
                                {(c) => <CommentItem comment={c} />}
                            </For>
                            <Show when={comments().length === 0}>
                                <div class="text-xxs text-bb-muted">NO COMMENTS</div>
                            </Show>
                        </Show>
                    </Show>
                    <input
                        type="text"
                        data-testid="comment-input"
                        class="w-full mt-1 bg-black/20 border border-bb-border text-bb-text font-mono text-xs p-1 focus:outline-none focus:border-bb-accent placeholder-bb-muted/50"
                        placeholder="// REPLY..."
                        value={commentText()}
                        disabled={commentBusy()}
                        onInput={(e) => setCommentText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitComment(); } }}
                    />
                </div>
            </Show>
        </div>
    );
};

export const FeedPanel = () => {
    const [weights, setWeights] = createSignal(null);
    onMount(() => {
        getFeedWeights().then(w => setWeights(w?.weights || w || null)).catch(() => {});
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
