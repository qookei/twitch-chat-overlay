'use strict';

const WS_ADDR = 'wss://irc-ws.chat.twitch.tv:443';
const VERBOSE = false;

const urlParams = new URLSearchParams(window.location.search);
const userName = urlParams.get('userName');
const userId = urlParams.get('userId');

function emoteUrl(id) {
	return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/light/1.0`;
}

function parseTags(tags) {
	const result = {
		displayName: 'error',
		color: '#FF00FF',
		badges: [],
		emotes: [],
	};

	for (const tag of tags) {
		const components = tag.split('=');

		switch (components[0]) {
			case 'display-name':
				result.displayName = components[1];
				break;
			case 'color':
				result.color = components[1];
				break;
			case 'emotes':
				const emotesRaw = components[1].split('/').filter(item => item.length);
				result.emotes = emotesRaw.map(raw => {
					const [id, rangesRaw] = raw.split(':');
					const ranges = rangesRaw.split(',');

					return ranges.map(rangeRaw => {
						const [_, start, end] = /([0-9]+)-([0-9]+)/.exec(rangeRaw);

						return {
							url: emoteUrl(id),
							start: Number(start),
							end: Number(end)
						};
					});
				}).flat();
				break;
			case 'badges':
				const badgesRaw = components[1].split(',').filter(item => item.length);
				result.badges = [].concat(result.badges, badgesRaw.map(raw => {
					const [_, name, kind] = /([a-zA-Z0-9_\-]+)\/([0-9]+)/.exec(raw);
					return {
						name: name,
						kind: kind
					};
				}));
				break;
		}
	}

	return result;
}

const imageCache = {};

async function loadImageFromCache(url, alt) {
	if (url in imageCache) {
		return await new Promise(realize => {
			const img = new Image();
			img.onload = () => realize(img);
			img.alt = alt;
			img.src = imageCache[url];
		});
	}

	const blob = await fetch(url).then(response => response.blob());
	const reader = new FileReader();

	const b64 = await new Promise(realize => {
		reader.onloadend = () => realize(reader.result);
		reader.readAsDataURL(blob);
	});

	imageCache[url] = b64;

	return await loadImageFromCache(url, alt);
}

async function applyEmotes(message, emotes) {
	const parts = [{ start: 0, content: message, isImage: false }];

	for (const emote of emotes) {
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];

			// Is the emote within this part?
			if (part.isImage || part.start > emote.start
				|| (part.start + part.content.length) < emote.end)
				continue;

			const content = [...part.content];

			const before = {
				start: part.start,
				content: content.slice(0, emote.start - part.start).join(''),
				isImage: false
			};

			const emoteName = content.slice(emote.start - part.start, emote.end - part.start + 1).join('');

			const emotePart = !emoteName.length
				? null
				: {
					start: emote.start,
					content: await loadImageFromCache(emote.url, emoteName),
					isImage: true
				};

			const after = {
				start: emote.end + 1,
				content: content.slice(emote.end - part.start + 1).join(''),
				isImage: false
			};

			const toInsert = [before, emotePart, after].filter(part => part !== null && (part.content.length || part.isImage));

			Array.prototype.splice.apply(parts, [i, 1].concat(toInsert));

			break;
		}
	}

	return parts;
}

function htmlEncode(text) {
	return text.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

async function makeChatElement(data, badgeData, messageComps) {
	const container = document.createElement('div');
	container.classList.add('chat-message-container');

	const outer = document.createElement('div');
	outer.classList.add('chat-message');

	const author = document.createElement('div');
	author.classList.add('chat-message-author');
	author.classList.add('chat-message-elem');

	const authorName = document.createElement('div');
	authorName.classList.add('chat-message-elem');
	authorName.style.color = data.color;
	authorName.innerText = data.displayName;
	author.append(authorName);

	const badgeIcons = document.createElement('div');
	for (const badge of data.badges) {
		// Skip badges we don't know (e.g. channel badges if we
		// don't know the user ID)
		if (!(badge.name in badgeData)) 
			continue;

		// If we don't know the about this version of badge, use
		// the base one.
		if (!(badge.kind in badgeData[badge.name].versions))
			badge.kind = '1';

		const badgeIcon = await loadImageFromCache(
			badgeData[badge.name].versions[badge.kind].image_url_1x,
			badgeData[badge.name].description);

		badgeIcon.classList.add('chat-message-author-badge');
		badgeIcons.appendChild(badgeIcon);
	}
	author.appendChild(badgeIcons);

	outer.appendChild(author);

	const body = document.createElement('div');
	body.classList.add('chat-message-body');
	body.classList.add('chat-message-elem');

	for (const comp of messageComps) {
		if (comp.isImage) {
			body.appendChild(comp.content);
		} else {
			const text = document.createElement('span');
			text.innerHTML = htmlEncode(comp.content);
			body.appendChild(text);
		}
	}

	twemoji.parse(body, { folder: 'svg', ext: '.svg' });

	outer.appendChild(body);

	container.append(outer);
	return container;
}

async function getGlobalBadges() {
	const response = await (fetch('https://badges.twitch.tv/v1/badges/global/display')
		.then(response => response.json()));

	return response.badge_sets;
}

async function getChannelBadges() {
	if (userId === null)
		return {};

	const response = await (fetch(`https://badges.twitch.tv/v1/badges/channels/${userId}/display`)
		.then(response => response.json()));

	return response.badge_sets;
}

async function getBadges() {
	const [global, channel] = await Promise.all([getGlobalBadges(), getChannelBadges()]);

	return Object.assign({}, global, channel);
}

function isInViewport(elem) {
	return elem.getBoundingClientRect().bottom >= document.scrollingElement.scrollTop;
}

getBadges().then(badgeData => {
		const ws = new WebSocket(WS_ADDR);

		ws.onerror = (evt) => {
			console.log('Error:', evt.data);
		};

		ws.onmessage = (evt) => {
			const lines = evt.data.split('\r\n');

			for (const line of lines) {
				if (line.startsWith('PING')) {
					ws.send(`PONG ${line.substring(6)}`);
				} else if (line.startsWith('@')) {
					const components = line.substring(1).split(' ');
					const tags = components[0].split(';');
					const data = parseTags(tags);

					const privmsgIndex = line.indexOf('PRIVMSG');
					const msg = line.substring(privmsgIndex + 11 + userName.length);
					applyEmotes(msg, data.emotes).then(async body => {
						const container = document.querySelector('#container');
						const child = await makeChatElement(data, badgeData, body);

						container.appendChild(child);

						for (let i = 0; i < container.children.length;) {
							const child = container.children[i];
							if (isInViewport(child)) {
								i++;
							} else {
								container.removeChild(child);
							}
						}

						document.scrollingElement.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
					});
				} else if (VERBOSE) {
					console.log('Unexpected message', line);
				}
			}
		};

		ws.onopen = (evt) => {
			ws.send('CAP REQ :twitch.tv/tags');
			ws.send('PASS blah');
			ws.send('NICK justinfan123');
			ws.send(`JOIN #${userName}`);
		}
	});
