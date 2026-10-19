// Older entries are forgotten, like a browser's history.
const MAX_ENTRIES = 50;

// Snapshots are kept only for the folders this many steps back or forward,
// as each one is a picture of the whole window.
const SNAPSHOT_RANGE = 3;

// What a Files window has shown, followed from its title, which names the
// folder, so that a swipe can show the folder it goes to before Files gets
// there. Files does not tell, so this is a guess: going to the folder just
// before or after the current one is taken to be going back or forward, and
// any other folder is a new one. Where the guess is wrong, Files shows the
// right folder as soon as it navigates.
export class FolderHistory {
    constructor(title) {
        this._entries = [{title, snapshot: null}];
        this._index = 0;
    }

    // The folder shown now: its title and its snapshot, if any.
    get current() {
        return this._entries[this._index];
    }

    // The folder `offset` steps forward (or back, if negative), or null.
    peek(offset) {
        return this._entries[this._index + offset] ?? null;
    }

    // Files turned out to have nothing `offset` steps forward (or back, if
    // negative): forget the guesses that way.
    forget(offset) {
        if (offset < 0) {
            this._entries.splice(0, this._index);
            this._index = 0;
        } else {
            this._entries.splice(this._index + 1);
        }
    }

    // The window now shows the folder with this title.
    navigated(title) {
        const entries = this._entries;
        if (entries[this._index].title === title)
            return;

        if (entries[this._index - 1]?.title === title) {
            this._index--;
        } else if (entries[this._index + 1]?.title === title) {
            this._index++;
        } else {
            entries.splice(this._index + 1);
            entries.push({title, snapshot: null});
            this._index++;
            if (entries.length > MAX_ENTRIES) {
                entries.shift();
                this._index--;
            }
        }

        for (const [i, entry] of entries.entries()) {
            if (Math.abs(i - this._index) > SNAPSHOT_RANGE)
                entry.snapshot = null;
        }
    }
}
