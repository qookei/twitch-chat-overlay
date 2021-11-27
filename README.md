# twitch-chat-overlay

Simple browser-based Twitch chat overlay.

## How to use

Launch a local web server (OBS browser source doesn't allow for URL parameters when using local files), for example:
```
$ python -m http.server
```

Then, use the following URL in the browser source: `http://<web server address>/?userName=<your user name>[&userId=<your user id>]`.

### Available options:
 - `userName` (required) - the user whose chat to look at.
 - `userId` (optional) - the ID of the user whose chat to look at (needed for fetching custom badges).

## Known issues
 - Messages with both ZWJ sequences and Twitch emotes will fall apart if the Twitch emote is after a ZWJ sequence.
