/*global define*/
define([
        './TileState'
    ], function(
        TileState) {
    "use strict";

    function TileReplacementQueue() {
        this.head = undefined;
        this.tail = undefined;
        this.count = 0;
        this._lastBeforeStartOfFrame = undefined;
    }

    TileReplacementQueue.prototype.markStartOfRenderFrame = function() {
        this._lastBeforeStartOfFrame = this.head;
    };

    TileReplacementQueue.prototype.trimTiles = function(maxTiles) {
        var tileToTrim = this.tail;
        var keepTrimming = true;
        while (keepTrimming &&
               typeof this._lastBeforeStartOfFrame !== 'undefined' &&
               this.count > maxTiles &&
               typeof tileToTrim !== 'undefined') {
            // Stop trimming after we process the last tile not used in the
            // current frame.
            keepTrimming = tileToTrim !== this._lastBeforeStartOfFrame;

            var previous = tileToTrim._replacementPrevious;
            if (tileToTrim.state !== TileState.TRANSITIONING) {
                tileToTrim.freeResources();
                this._remove(tileToTrim);
            }
            tileToTrim = previous;
        }
    };

    TileReplacementQueue.prototype._remove = function(item) {
        var previous = item._replacementPrevious;
        var next = item._replacementNext;

        if (item === this._lastBeforeStartOfFrame) {
            this._lastBeforeStartOfFrame = next;
        }

        if (item === this.head) {
            this.head = next;
        } else {
            previous._replacementNext = next;
        }

        if (item === this.tail) {
            this.tail = previous;
        } else {
            next._replacementPrevious = previous;
        }

        item._replacementPrevious = undefined;
        item._replacementNext = undefined;

        --this.count;
    };

    TileReplacementQueue.prototype.markTileRendered = function(item) {
        var insertionPoint = this.head;
        if (insertionPoint === item) {
            if (item === this._lastBeforeStartOfFrame) {
                this._lastBeforeStartOfFrame = item._replacementNext;
            }
            return;
        }

        ++this.count;

        if (typeof this.head === 'undefined') {
            // no other tiles in the list
            item._replacementPrevious = undefined;
            item._replacementNext = undefined;
            this.head = item;
            this.tail = item;
            return;
        }

        if (typeof item._replacementPrevious !== 'undefined' || typeof item._replacementNext !== 'undefined') {
            // tile already in the list, remove from its current location
            this._remove(item);
        }

        if (typeof insertionPoint === 'undefined') {
            if (typeof this.head === 'undefined') {
                item._replacementPrevious = undefined;
                item._replacementNext = undefined;
                this.head = item;
                this.tail = item;
            } else {
                item._replacementPrevious = this.tail;
                item._replacementNext = undefined;
                this.tail._replacementNext = item;
                this.tail = item;
            }
            return;
        }

        var insertAfter = insertionPoint._replacementPrevious;
        item._replacementPrevious = insertAfter;
        if (typeof insertAfter !== 'undefined') {
            insertAfter._replacementNext = item;
        }

        item._replacementNext = insertionPoint;
        insertionPoint._replacementPrevious = item;

        if (insertionPoint === this.head) {
            this.head = item;
        }
    };

    return TileReplacementQueue;
});
