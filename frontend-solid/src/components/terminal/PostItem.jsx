import { For, Show, createSignal, createEffect, onCleanup } from "solid-js";
import { feedStore } from "../../store/feedStore";
import { api, getPostComments, createComment, requestBlob, followUser } from "../../services/api";

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
    const [localLiked, setLocalLiked] = createSignal(null);

    const localLike = async () => {
        const wasLiked = Boolean(props.post.liked_by_user);
        setLocalLiked(!wasLiked);
        try {
            if (wasLiked) await api.posts.unlikePost(props.post.id);
            else await api.posts.likePost(props.post.id);
        } catch {
            setLocalLiked(wasLiked);
        }
    };

    const handleLike = async () => {
        if (props.disableFeedStore) {
            await localLike();
            return;
        }
        const postId = props.post.id;
        if (props.post.liked_by_user) {
            feedStore.unlikePost(postId);
            try { await api.posts.unlikePost(postId); } catch { feedStore.likePost(postId); }
        } else {
            feedStore.likePost(postId);
            try { await api.posts.likePost(postId); } catch { feedStore.unlikePost(postId); }
        }
    };

    const isLiked = () => props.disableFeedStore ? (localLiked() ?? props.post.liked_by_user) : props.post.liked_by_user;
    const likeCount = () => {
        if (!props.disableFeedStore) return props.post.like_count || 0;
        return (props.post.like_count || 0) + (localLiked() === true && !props.post.liked_by_user ? 1 : localLiked() === false && props.post.liked_by_user ? -1 : 0);
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
                    <Show when={!props.disableFeedStore}>
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
                    </Show>
                    <button
                        type="button"
                        class={`cursor-pointer hover:text-white transition-colors uppercase ${isLiked() ? 'text-market-up font-bold' : 'text-bb-muted'}`}
                        onClick={handleLike}
                        disabled={props.post.is_temp}
                    >
                        [{isLiked() ? 'LIKED' : 'LIKE'}:{likeCount()}]
                    </button>
                    <Show when={!props.disableFeedStore && feedStore.state.discoverMode}>
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

export default PostItem;
