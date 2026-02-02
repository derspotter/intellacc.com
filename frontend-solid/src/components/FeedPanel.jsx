import { onMount, For, Show } from "solid-js";
import { Panel } from "./ui/Panel";
import { feedStore } from "../store/feedStore";

const PostItem = (props) => {
    return (
        <div class="p-2 border-b border-bb-border/30 hover:bg-white/5 text-sm">
            <div class="flex justify-between items-baseline mb-1">
                <span class="font-bold text-bb-accent text-xs">@{props.post.username}</span>
                <span class="text-xxs text-bb-muted font-mono">{new Date(props.post.created_at).toLocaleTimeString()}</span>
            </div>
            <p class="text-bb-text mb-1 break-words whitespace-pre-wrap">{props.post.content}</p>
            <div class="flex gap-2 text-xxs text-bb-muted font-mono">
                <span>GRP: DEFAULT</span>
                <span>ID: {props.post.id}</span>
            </div>
        </div>
    );
};

export const FeedPanel = (props) => {
    onMount(() => {
        feedStore.loadPosts();
    });

    return (
        <Panel title="[1] FEED // LIVE" class="h-full">
            <Show when={!feedStore.state.loading} fallback={<div class="p-2 text-bb-muted font-mono animate-pulse">Running query...</div>}>
                <div class="flex flex-col">
                    <For each={feedStore.state.posts}>
                        {(post) => <PostItem post={post} />}
                    </For>
                </div>
            </Show>
        </Panel>
    );
};
