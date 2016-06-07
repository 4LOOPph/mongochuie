(function() {
    var colllist = db.getCollectionNames();

    colllist.forEach(function(collectionname) {
        if (!db.hasOwnProperty(collectionname)) {
            Object.defineProperty(db, collectionname, {
                get: function() {
                    return db.getCollection(collectionname);
                }
            });
        }
    });

    var result = '%%CODE%%';

    if (typeof result === 'function') {
        result = result();
    }

    if (!result) {
        return {};
    }

    if (typeof result === 'number') {
        return {number: result};
    }

    if (typeof result === 'string') {
        return {message: result};
    }

    if (typeof result === 'object') {
        if (typeof result.toArray === 'function') {
            return result.toArray();
        } else {
            return result;
        }
    }

    return result;
})();