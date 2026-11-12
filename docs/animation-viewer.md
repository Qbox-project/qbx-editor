# Animation dictionary viewer

Click a `.ycd` file in the Explorer, or run **FiveM: Open Animation Dictionary**. The viewer lists the clips of the dictionary, plays the selected clip on a skeleton, and gives you the two names a script needs to play it: the dictionary name, which is the file name without `.ycd`, and the clip name.

## Playback

The selected clip is drawn as a ped skeleton: left limbs in one colour, right limbs in another, spine and head in the text colour. The grid is the ground the ped stands on, one metre below its origin, and the green arrow points the way the ped faces.

| Input | Action |
| --- | --- |
| **Play** / **Pause**, or Space on the figure | Start and stop |
| Slider | Move through the clip |
| Left and right arrow keys on the figure | Step one frame |
| **Speed**, **Loop** | Playback rate and repeat |
| Drag, scroll | Orbit and zoom |
| **Copy phase** | The current position as a number from 0 to 1, as `GetEntityAnimCurrentTime` reports it and `startPhase` takes it |

The read-out shows time, frame and phase. A clip that is a single pose is drawn without playback.

Bones come from the clip's own tracks. A bone the clip does not animate keeps its bind pose; a bone it rotates without storing a position uses the standard ped bind offset, and the detail panel says how many bones that applies to. Face, helper and prop bones are animated in many clips but are not drawn. A clip that animates something other than the standard ped skeleton, such as an animal, a vehicle or a prop, is decoded and reported, but has no figure.

## Names and snippets

Search by clip name or hash. Select a clip to see its length, frame count and frame rate, and to copy:

| Action | Result |
| --- | --- |
| **Copy dictionary name** | `anim@heists@box_carry@` |
| **Copy clip name** / **Copy both** | `idle`, or `'anim@heists@box_carry@', 'idle'` |
| **Copy ox_lib call** | `lib.playAnim(cache.ped, 'dictionary', 'clip')` |
| **Copy natives** | `RequestAnimDict`, a wait for `HasAnimDictLoaded`, `TaskPlayAnim` and `RemoveAnimDict` |

The native snippet plays the clip once with default blend speeds. Change the flag argument of `TaskPlayAnim` for looping, upper-body or movement-enabled playback.

A clip's length is its time range divided by its rate, which is how long the game plays it. Poses made as emotes are often a few frames long or carry a very low rate; the viewer shows the rate when it is not 1.

The view refreshes when the file changes on disk. It is read-only and local.

## Limits

- Files up to 64 MiB; RSC7 pages expanding to at most 128 MiB; at most 20,000 clips; four million decoded values per animation (frames times tracks).
- Clip dictionaries of resource version 46.
- The figure is a skeleton, not a skinned ped: no mesh, clothing or props are drawn, and root motion tracks are not applied.
- Clips that play a list of animations are listed but not played. Clip tags and properties, such as audio and foot-step events, are not listed.

## Format sources

The reader and decoder are written for this extension. The layout and the channel encodings were checked against CodeWalker at commit `485d56bec00262ed7fa472261cce7bbc6202b96e` ([Clip.cs](https://github.com/dexyfex/CodeWalker/blob/485d56bec00262ed7fa472261cce7bbc6202b96e/CodeWalker.Core/GameFiles/Resources/Clip.cs)) and against openly published emote dictionaries: every decoded rotation has unit length, and files from four authors agree on the ped's bone offsets. The bone tags and parent links of the ped skeleton are the published bone list; the bind offsets are the values those animation files store.

Tests build their own dictionaries, covering each channel encoding; no game asset is distributed.
