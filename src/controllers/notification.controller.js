const httpStatus = require('http-status');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');

const getNotifications = catchAsync(async (req, res) => {
    try {
        const { role } = req.query;
        
        // Mock notifications data (replace with actual database query later)
        const notifications = [
            {
                id: 1,
                title: "New Author Registration",
                message: "A new author has registered",
                timestamp: new Date(),
                read: false
            }
        ];

        res.status(httpStatus.OK).json({
            status: true,
            data: notifications
        });

    } catch (error) {
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, error.message);
    }
});

module.exports = {
    getNotifications
};